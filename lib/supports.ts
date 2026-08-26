import type { SliceResult } from "./slice";
import { nativeReady, wasmDilate } from "./native";

/**
 * SLA podpory — Chitubox model (2026-08-26, po researchu):
 *
 *   TIP (kontaktní bod, malý Ø)          ← dotyk s modelem
 *   ┃ TOP/MIDDLE sloup — VŽDY SVISLÝ     ← zužuje se nahoru
 *   ┃                                    ← kolizní kontrola celé cesty
 *   ▙ BOTTOM patka / deska
 *
 * Pravidla (dle Chitubox docs):
 *  • Podpora se umístí JEN když má od desky ke kotvě VOLNOU SVISLOU CESTU
 *    (jinak se kotva přeskočí — „Spacing From Model")
 *  • Sloup je rovný, mírně se rozšiřuje k dolů (stabilita)
 *  • Stabilita souboru = PŘÍČNÉ VZPĚRY (cross bracing) mezi sousedy — X vzory
 */

export interface SupportOptions {
  enabled: boolean;
  /** poloměr sloupu (px) */
  radiusPx?: number;
  /** poloměr špičky (px) */
  tipPx?: number;
  legacyOverhangPx?: number;
  legacyMinComponentPx?: number;
}

export interface SupportResult {
  result: SliceResult;
  mask: Uint8Array[];
}

const DEFAULTS = {
  radiusPx: 3,
  tipPx: 2,
};

/** Abstrakce: dotaz na model + plnění — bitmapy i full-res depth mapy. */
export interface PillarCtx {
  N: number;
  modelAt(li: number, x: number, y: number): boolean;
  fill(li: number, cx: number, cy: number, r: number): void;
}

export interface PlacedPillar {
  x: number;
  y: number;
  top: number;
}

/** kruh kolem (x,y) zasahuje do modelu? */
function circleBlocked(
  ctx: PillarCtx,
  li: number,
  x: number,
  y: number,
  r: number,
  W: number,
  H: number
): boolean {
  const r2 = r * r;
  const x0 = Math.max(0, x - r);
  const x1 = Math.min(W - 1, x + r);
  const y0 = Math.max(0, y - r);
  const y1 = Math.min(H - 1, y + r);
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const dx = xx - x;
      const dy = yy - y;
      if (dx * dx + dy * dy <= r2 && ctx.modelAt(li, xx, yy)) return true;
    }
  }
  return false;
}

/**
 * Umístění sloupů (Chitubox model):
 *  1) přímá svislá cesta volná → klasický svislý sloup
 *     (špička smí dotýkat modelu — k tomu je tu; kontroluje se jen tělo sloupu)
 *  2) blokovaná → hledá volný sloup v okolí („Max Contact Point Offset")
 *     a napojí ho na kotvu ŠIKMÝM SPOJEM (top segment)
 *  3) nic volného v okolí → kotva přeskočena
 */
export function placeSupports(
  anchors: { x: number; y: number; layer: number }[],
  ctx: PillarCtx,
  radiusPx: number,
  tipPx: number,
  W: number,
  H: number,
  radiusBottomPx?: number
): PlacedPillar[] {
  const rBot = Math.max(radiusPx, Math.round(radiusBottomPx ?? radiusPx * 1.4));
  const pxPerMm = 223.642 / W;
  const maxOff = Math.max(4, Math.round(4 / pxPerMm)); // posun kotvy ~4 mm

  // je tělo sloupu na (x,y) volné od desky až po vrstvu `from` (vyjma)?
  const bodyFree = (from: number, x: number, y: number): boolean => {
    for (let li = Math.min(from, ctx.N - 1); li >= 0; li--) {
      if (circleBlocked(ctx, li, x, y, radiusPx, W, H)) return false;
    }
    return true;
  };
  // nejvyšší vrstva, od které je sloup na (x,y) volný až k desce
  const highestFree = (from: number, x: number, y: number): number => {
    let li = Math.min(from - 1, ctx.N - 1);
    while (li >= 0 && !circleBlocked(ctx, li, x, y, radiusPx, W, H)) li--;
    return li + 1;
  };

  const sorted = [...anchors].sort((a, b) => b.layer - a.layer);
  const placed: PlacedPillar[] = [];

  for (const a of sorted) {
    if (a.x < 0 || a.y < 0 || a.x >= W || a.y >= H) continue;
    const top = Math.min(Math.max(0, a.layer), ctx.N - 1);

    // špička u kotvy — vždy (dotyk s modelem je účel)
    const drawTipAndPillar = (px: number, py: number, pillarTop: number) => {
      ctx.fill(top, a.x, a.y, tipPx);
      // šikmý spoj ze špičky ke sloupu (pokud jsou rozdílné pozice)
      if (pillarTop >= 0 && (px !== a.x || py !== a.y)) {
        const steps = Math.max(
          top - pillarTop,
          Math.round(Math.hypot(px - a.x, py - a.y)),
          1
        );
        for (let s = 0; s <= steps; s++) {
          const f = s / steps;
          const li = Math.round(top - (top - pillarTop) * f);
          const cx = Math.round(a.x + (px - a.x) * f);
          const cy = Math.round(a.y + (py - a.y) * f);
          if (li >= 0 && li < ctx.N && li <= top) ctx.fill(li, cx, cy, radiusPx);
        }
      }
      // sloup dolů (rozšiřující se k desce)
      for (let li = pillarTop - 1; li >= 0; li--) {
        const span = Math.max(1, pillarTop);
        const f2 = 1 - li / span;
        const r = Math.round(radiusPx + (rBot - radiusPx) * f2);
        ctx.fill(li, px, py, r);
      }
    };

    // 1) přímá cesta: tělo sloupu (pod špičkou) musí být celé volné
    if (bodyFree(top, a.x, a.y)) {
      placed.push({ x: a.x, y: a.y, top });
      drawTipAndPillar(a.x, a.y, top);
      continue;
    }

    // 2) posun do stran: najdi volné místo pro sloup („Max Contact Point Offset")
    let found: { x: number; y: number; clearTop: number } | null = null;
    for (let ring = 2; ring <= maxOff && !found; ring += 2) {
      const step = Math.max(2, ring >> 2);
      for (let dy = -ring; dy <= ring && !found; dy += step) {
        for (let dx = -ring; dx <= ring && !found; dx += step) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const nx = a.x + dx;
          const ny = a.y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const clearTop = highestFree(top, nx, ny);
          // sloup musí sahat aspoň do 40 % výšky kotve (jinak most moc dlouhý)
          if (clearTop >= Math.floor(top * 0.4)) found = { x: nx, y: ny, clearTop };
        }
      }
    }
    if (!found) continue; // nikde volno — kotva přeskočena

    placed.push({ x: found.x, y: found.y, top: found.clearTop });
    drawTipAndPillar(found.x, found.y, found.clearTop);
  }
  return placed;
}

// helpery pro čitelnost výše
function ax0(x: number): number {
  return x;
}
function ay0(y: number): number {
  return y;
}

/**
 * Příčné vzpěry (Chitubox „Cross Bracing"): X-diagonály mezi sousedními
 * sloupy pro stabilitu — tenké čáry, od výšky lo po hi nižšího ze dvou sloupů.
 */
export interface BraceLine {
  x1: number;
  y1: number;
  l1: number;
  x2: number;
  y2: number;
  l2: number;
}

/** Spočítá X-vzpěry mezi sousedními sloupy (max maxXYPx od sebe). */
export function crossBraceLines(
  pillars: PlacedPillar[],
  maxXYPx: number
): BraceLine[] {
  const lines: BraceLine[] = [];
  const used = new Set<string>();
  for (let i = 0; i < pillars.length; i++) {
    const cand: { j: number; d: number }[] = [];
    for (let j = 0; j < pillars.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(pillars[j].x - pillars[i].x, pillars[j].y - pillars[i].y);
      if (d > 0 && d <= maxXYPx) cand.push({ j, d });
    }
    cand.sort((a, b) => a.d - b.d);
    for (const { j } of cand.slice(0, 3)) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (used.has(key)) continue;
      used.add(key);
      const A = pillars[i];
      const B = pillars[j];
      const topMin = Math.min(A.top, B.top);
      const lo = Math.max(2, Math.floor(topMin * 0.35));
      const hi = Math.max(lo + 1, topMin - 2);
      if (hi <= lo) continue;
      lines.push({ x1: A.x, y1: A.y, l1: lo, x2: B.x, y2: B.y, l2: hi });
      lines.push({ x1: A.x, y1: A.y, l1: hi, x2: B.x, y2: B.y, l2: lo });
    }
  }
  return lines;
}

/** Vyplní úsečku vzpěry (tenký kruh na každém kroku, jen do prázdného prostoru). */
function fillBraceLine(
  ctx: PillarCtx,
  x1: number,
  y1: number,
  l1: number,
  x2: number,
  y2: number,
  l2: number,
  r: number,
  W: number,
  H: number
) {
  const steps = Math.max(Math.abs(l2 - l1), Math.round(Math.hypot(x2 - x1, y2 - y1)), 1);
  for (let s = 0; s <= steps; s++) {
    const f = s / steps;
    const li = Math.round(l1 + (l2 - l1) * f);
    const cx = Math.round(x1 + (x2 - x1) * f);
    const cy = Math.round(y1 + (y2 - y1) * f);
    if (li < 0 || li >= ctx.N || cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
    ctx.fill(li, cx, cy, r);
  }
}

/**
 * Automatické podpory (slice pipeline): kotvy → svislé sloupy → vzpěry.
 * Vrací i masku přidaných pixelů (pro 3D zobrazení podpor).
 */
export function generateSupports(
  slice: SliceResult,
  opts: SupportOptions,
  anchors?: { x: number; y: number; layer: number }[]
): SupportResult {
  if (!opts.enabled) {
    return {
      result: slice,
      mask: slice.layers.map(() => new Uint8Array(0)),
    };
  }
  const W = slice.resolutionX;
  const H = slice.resolutionY;
  const radius = opts.radiusPx ?? DEFAULTS.radiusPx;
  const tip = opts.tipPx ?? DEFAULTS.tipPx;

  const layers = slice.layers.map((l) => new Uint8Array(l.data));
  const mask = slice.layers.map(() => new Uint8Array(W * H));

  const ctx: PillarCtx = {
    N: layers.length,
    modelAt: (li, x, y) => slice.layers[li].data[y * W + x] !== 0,
    fill: (li, cx, cy, r) =>
      fillCircleIfEmpty(layers[li], mask[li], slice.layers[li].data, cx, cy, r, W, H),
  };

  let pillars: PlacedPillar[] = [];
  if (anchors) {
    // moderní cesta: kotvy z meshí (úhlová detekce) — jen volné svislé cesty
    pillars = placeSupports(anchors, ctx, radius, tip, W, H);
  } else {
    // fallback (stará cesta bez kotev): každá vrstva vs předchozí (zřídka použito)
    const overhangPx = opts.legacyOverhangPx ?? 1;
    const minSize = opts.legacyMinComponentPx ?? 12;
    const legacy: { x: number; y: number; layer: number }[] = [];
    for (let i = 1; i < layers.length; i++) {
      const cur = layers[i];
      const prevDil = nativeReady()
        ? wasmDilate(layers[i - 1], W, H, overhangPx)
        : dilate(layers[i - 1], W, H, overhangPx);
      const oh = new Uint8Array(W * H);
      for (let p = 0; p < W * H; p++) oh[p] = cur[p] && !prevDil[p] ? 1 : 0;
      for (const c of components(oh, W, H, minSize)) legacy.push({ x: c.x, y: c.y, layer: i });
    }
    pillars = placeSupports(legacy, ctx, radius, tip, W, H);
  }

  // příčné vzpěry mezi sousedy (max ~15 mm od sebe)
  const pxPerMm = 223.642 / W;
  const maxXY = Math.max(8, Math.round(15 / pxPerMm));
  const braceR = Math.max(1, Math.round(0.5 / pxPerMm)); // ~0,5 mm
  const lines = crossBraceLines(pillars, maxXY);
  for (const L of lines) fillBraceLine(ctx, L.x1, L.y1, L.l1, L.x2, L.y2, L.l2, braceR, W, H);

  return {
    result: {
      ...slice,
      layers: layers.map(
        (data, index) => ({ index, z: slice.layers[index].z, data })
      ),
    },
    mask,
  };
}

// ------------------------------------------------------------- pomocné

function dilate(src: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!src[y * W + x]) continue;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(W - 1, x + r);
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(H - 1, y + r);
      for (let yy = y0; yy <= y1; yy++) out.fill(1, yy * W + x0, yy * W + x1 + 1);
    }
  }
  return out;
}

/** flood-fill komponenty (fallback detekce ostrůvků) */
function components(
  img: Uint8Array,
  W: number,
  H: number,
  minSize: number
): { x: number; y: number }[] {
  const seen = new Uint8Array(W * H);
  const out: { x: number; y: number }[] = [];
  const stack: number[] = [];
  for (let p0 = 0; p0 < W * H; p0++) {
    if (!img[p0] || seen[p0]) continue;
    stack.length = 0;
    stack.push(p0);
    seen[p0] = 1;
    let count = 0;
    let sx = 0;
    let sy = 0;
    while (stack.length) {
      const p = stack.pop()!;
      count++;
      sx += p % W;
      sy += (p / W) | 0;
      const x = p % W;
      const y = (p / W) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const np = ny * W + nx;
          if (img[np] && !seen[np]) {
            seen[np] = 1;
            stack.push(np);
          }
        }
      }
    }
    if (count >= minSize) out.push({ x: Math.round(sx / count), y: Math.round(sy / count) });
  }
  return out;
}

/** vyplní kruh jen do prázdna (nepřepisuje model) */
function fillCircleIfEmpty(
  layer: Uint8Array,
  mask: Uint8Array | null,
  orig: Uint8Array,
  cx: number,
  cy: number,
  r: number,
  W: number,
  H: number
) {
  const r2 = r * r;
  const x0 = Math.max(0, cx - r);
  const x1 = Math.min(W - 1, cx + r);
  const y0 = Math.max(0, cy - r);
  const y1 = Math.min(H - 1, cy + r);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const idx = y * W + x;
      if (dx * dx + dy * dy <= r2 && !orig[idx]) {
        layer[idx] = 1;
        if (mask) mask[idx] = 1;
      }
    }
  }
}
