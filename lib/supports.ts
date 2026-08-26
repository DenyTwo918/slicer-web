import type { SliceResult } from "./slice";
import { nativeReady, wasmDilate } from "./native";

export interface SupportOptions {
  enabled: boolean;
  /** max. povolený přesah mezi vrstvami v px (1 px ≈ 0,13 mm při naší slicovací rozlišení) */
  overhangPx?: number;
  /** poloměr sloupu podpory v px */
  radiusPx?: number;
  /** poloměr špičky (kontakt s modelem) v px */
  tipPx?: number;
  /** minimální velikost ostrůvku, který se podepírá (px) */
  minComponentPx?: number;
}

const DEFAULTS = {
  overhangPx: 1,
  radiusPx: 8, // ~1 mm
  tipPx: 4,
  minComponentPx: 3,
};

/** Dilatace binárního rastru (box r×r) — "kde už bylo pod tím".
 *  S WASM kernely (SIMD) jde ~4–10× rychleji; jinak JS fallback. */
function dilate(src: Uint8Array, W: number, H: number, r: number): Uint8Array {
  if (nativeReady()) return wasmDilate(src, W, H, r);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!src[y * W + x]) continue;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(W - 1, x + r);
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(H - 1, y + r);
      for (let yy = y0; yy <= y1; yy++) {
        out.fill(1, yy * W + x0, yy * W + x1 + 1);
      }
    }
  }
  return out;
}

/** Flood-fill komponenty (8-okolí); vrací kotvu = první pixel komponenty
 *  (přímo NA přesahu — ne těžiště, které může být v díře). */
function components(
  mask: Uint8Array,
  W: number,
  H: number,
  minSize: number
): { x: number; y: number; size: number }[] {
  const res: { x: number; y: number; size: number }[] = [];
  const stack: number[] = [];
  for (let p = 0; p < W * H; p++) {
    if (!mask[p]) continue;
    // flood
    const seedX = p % W;
    const seedY = (p / W) | 0;
    stack.length = 0;
    stack.push(p);
    mask[p] = 0;
    let n = 0;
    while (stack.length) {
      const idx = stack.pop()!;
      const x = idx % W;
      const y = (idx / W) | 0;
      n++;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = ny * W + nx;
          if (mask[ni]) {
            mask[ni] = 0;
            stack.push(ni);
          }
        }
      }
    }
    if (n >= minSize) {
      res.push({ x: seedX, y: seedY, size: n });
    }
  }
  return res;
}

function fillCircle(layer: Uint8Array, cx: number, cy: number, r: number, W: number, H: number) {
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) layer[y * W + x] = 1;
    }
  }
}

/** Vyplní kruh JEN tam, kde model není (orig = 0) — podpory neprocházejí modelem. */
function fillCircleIfEmpty(
  layer: Uint8Array,
  mask: Uint8Array,
  orig: Uint8Array,
  cx: number,
  cy: number,
  r: number,
  W: number,
  H: number
) {
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const idx = y * W + x;
      if (dx * dx + dy * dy <= r2 && !orig[idx]) {
        layer[idx] = 1;
        mask[idx] = 1;
      }
    }
  }
}

export interface SupportResult {
  result: SliceResult;
  /** maska podpor — 1 = pixel přidaný podporami (per vrstva) */
  mask: Uint8Array[];
}

/**
 * Automatické podpory: sloupy od desky ke kotvám (přesahy detekované
 * z meshí — viz lib/supportDetect.ts; kotvy jsou mimo model a sloupy se
 * plní JEN do prázdného prostoru, takže neprocházejí stěnami).
 * Vrací i masku přidaných pixelů (pro 3D zobrazení podpor zvlášť).
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
  const overhangPx = opts.overhangPx ?? DEFAULTS.overhangPx;
  const radius = opts.radiusPx ?? DEFAULTS.radiusPx;
  const tip = opts.tipPx ?? DEFAULTS.tipPx;
  const minSize = opts.minComponentPx ?? DEFAULTS.minComponentPx;

  const layers = slice.layers.map((l) => new Uint8Array(l.data));
  const mask = slice.layers.map(() => new Uint8Array(W * H));
  const N = layers.length;

  const pillars: { x: number; y: number; top: number }[] = [];

  if (anchors) {
    // moderní cesta: kotvy z meshí (úhlová detekce) — žádný pixel-šum
    for (const a of anchors) {
      if (a.x < 0 || a.y < 0 || a.x >= W || a.y >= H) continue;
      pillars.push({ x: a.x, y: a.y, top: Math.min(Math.max(0, a.layer), N - 1) });
    }
  } else {
    // fallback (testy/stará cesta): pixel-diff přesahy + ostrůvky
    for (let i = 1; i < N; i++) {
      const cur = layers[i];
      const prevDil = dilate(layers[i - 1], W, H, overhangPx);
      // přesahové pixely: on tady, nebyl pod tím (dilatovaně)
      const oh = new Uint8Array(W * H);
      for (let p = 0; p < W * H; p++) {
        oh[p] = cur[p] && !prevDil[p] ? 1 : 0;
      }
      const comps = components(oh, W, H, minSize);
      for (const c of comps) {
        pillars.push({ x: c.x, y: c.y, top: i });
      }
    }
  }

  // sloupy od desky (vrstva 0) po vrchní vrstvu s podpěrou — jen v prázdném prostoru.
  // PrusaSlicer-style routing: když sloup narazí na model, ukloní se (bridge) a obejde ho.
  // STROMY: nejvyšší sloup = kmen, ostatní se k němu sklánějí a spojují se s ním.
  const orig = slice.layers.map((l) => l.data);
  const sorted = [...pillars].sort((a, b) => b.top - a.top);
  const trunks: { x: number; y: number }[][] = []; // [vrstva] → středy kmenů
  for (const p of sorted) {
    routePillar(layers, mask, orig, p.x, p.y, p.top, radius, tip, W, H, trunks);
  }

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

/**
 * Sloup podpory s routingem (jako stromové podpory v PrusaSliceru).
 * Špička se dotýká modelu u kotvy; sloup klesá dolů a když narazí na model,
 * ukloní se (hledá volné místo v okolí s lookaheadem) a obejde ho, aby došel
 * až k desce. Maska se plní JEN do prázdného prostoru (neprochází stěnami).
 */
function routePillar(
  layers: Uint8Array[],
  mask: Uint8Array[],
  orig: Uint8Array[],
  ax: number,
  ay: number,
  topLayer: number,
  radius: number,
  tip: number,
  W: number,
  H: number,
  trunks?: { x: number; y: number }[][]
) {
  const N = layers.length;
  // max. úhyb sloupu: ~7,5 mm (v px slicovacího rastru)
  const pxPerMm = 223.642 / W;
  const maxDetourPx = Math.max(4, Math.round(7.5 / pxPerMm));
  // spojení se kmenem: středy blíž než 2× poloměr = kruhy se překrývají
  const mergeDistPx = radius * 2;
  // kruh kolem (x,y) v layer li zasahuje do modelu?
  const blockedAt = (li: number, x: number, y: number, r: number): boolean => {
    const l = orig[li];
    const r2 = r * r;
    const x0 = Math.max(0, x - r);
    const x1 = Math.min(W - 1, x + r);
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(H - 1, y + r);
    for (let yy = y0; yy <= y1; yy++) {
      const row = yy * W;
      for (let xx = x0; xx <= x1; xx++) {
        const dx = xx - x;
        const dy = yy - y;
        if (dx * dx + dy * dy <= r2 && l[row + xx]) return true;
      }
    }
    return false;
  };
  // dá se z (x,y) v layer li klesat dál? (lookahead vrstev)
  const descentFree = (li: number, x: number, y: number, r: number, k: number): boolean => {
    for (let i = li; i >= Math.max(0, li - k); i--) {
      if (blockedAt(i, x, y, r)) return false;
    }
    return true;
  };

  // špička vždy u kotvy (dotýká se modelu — to je správně)
  fillCircleIfEmpty(layers[topLayer], mask[topLayer], orig[topLayer], ax, ay, tip, W, H);

  // nejbližší kmen na dané vrstvě
  const nearestTrunk = (li: number, x: number, y: number) => {
    if (!trunks || !trunks[li]) return null;
    let bestD = Infinity;
    let bx = -1;
    let by = -1;
    for (const c of trunks[li]) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestD) {
        bestD = d;
        bx = c.x;
        by = c.y;
      }
    }
    return bestD === Infinity ? null : { d: bestD, x: bx, y: by };
  };

  const trace: { li: number; x: number; y: number }[] = [{ li: topLayer, x: ax, y: ay }];
  let cx = ax;
  let cy = ay;
  for (let li = Math.min(topLayer - 1, N - 1); li >= 0; li--) {
    // 1) spojení se kmenem?
    const t = nearestTrunk(li, cx, cy);
    if (t && t.d <= mergeDistPx) {
      trace.push({ li, x: cx, y: cy });
      if (trunks) {
        for (const t2 of trace) {
          (trunks[t2.li] ??= []).push({ x: t2.x, y: t2.y });
        }
      }
      return; // spojeno — dál pokračuje kmen
    }

    // 2) blokováno → úhyb: hledej volné místo v prstencích (od středu ven)
    if (blockedAt(li, cx, cy, radius)) {
      let found = false;
      for (let ring = 1; ring <= maxDetourPx && !found; ring++) {
        for (let dy = -ring; dy <= ring && !found; dy++) {
          for (let dx = -ring; dx <= ring && !found; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            if (!blockedAt(li, nx, ny, radius) && descentFree(li, nx, ny, radius, 15)) {
              cx = nx;
              cy = ny;
              found = true;
            }
          }
        }
      }
      if (!found) break; // zaseknutý — sloup končí (model je moc blízko)
      fillCircleIfEmpty(layers[li], mask[li], orig[li], cx, cy, radius, W, H);
      trace.push({ li, x: cx, y: cy });
      continue;
    }

    // 3) volno → skláněj se ke kmenu (pokud je dosažitelný), jinak rovně
    if (t && t.d <= mergeDistPx + li * 2) {
      // dosažitelnost: zbylých `li` vrstev × max 2 px/vrstvu
      const dx = t.x - cx;
      const dy = t.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      const step = Math.min(2, len);
      const nx = cx + Math.round((dx / len) * step);
      const ny = cy + Math.round((dy / len) * step);
      if (!blockedAt(li, nx, ny, radius)) {
        cx = nx;
        cy = ny;
        fillCircleIfEmpty(layers[li], mask[li], orig[li], cx, cy, radius, W, H);
        trace.push({ li, x: cx, y: cy });
        continue;
      }
    }
    fillCircleIfEmpty(layers[li], mask[li], orig[li], cx, cy, radius, W, H);
    trace.push({ li, x: cx, y: cy });
  }

  // sloup dokončen → registruj trasu jako kmen pro budoucí sloupy
  if (trunks) {
    for (const t2 of trace) {
      (trunks[t2.li] ??= []).push({ x: t2.x, y: t2.y });
    }
  }
}
