import type { SliceResult } from "./slice";

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

/** Dilatace binárního rastru (box r×r) — "kde už bylo pod tím". */
function dilate(src: Uint8Array, W: number, H: number, r: number): Uint8Array {
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

/** Flood-fill komponenty (8-okolí); vrací centroidy komponent ≥ minSize. */
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
    stack.length = 0;
    stack.push(p);
    mask[p] = 0;
    let sumX = 0;
    let sumY = 0;
    let n = 0;
    while (stack.length) {
      const idx = stack.pop()!;
      const x = idx % W;
      const y = (idx / W) | 0;
      sumX += x;
      sumY += y;
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
      res.push({ x: sumX / n, y: sumY / n, size: n });
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

/**
 * Automatické podpory: najde "přesahy" (pixely, které v předchozí vrstvě
 * nebyly pokryté) a ostrůvky a podepře je sloupem od desky nahoru.
 * Sloupy se zapíšou přímo do vrstev (binární rastr).
 */
export function generateSupports(
  slice: SliceResult,
  opts: SupportOptions
): SliceResult {
  if (!opts.enabled) return slice;
  const W = slice.resolutionX;
  const H = slice.resolutionY;
  const overhangPx = opts.overhangPx ?? DEFAULTS.overhangPx;
  const radius = opts.radiusPx ?? DEFAULTS.radiusPx;
  const tip = opts.tipPx ?? DEFAULTS.tipPx;
  const minSize = opts.minComponentPx ?? DEFAULTS.minComponentPx;

  const layers = slice.layers.map((l) => new Uint8Array(l.data));
  const N = layers.length;

  const pillars: { x: number; y: number; top: number }[] = [];

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

  // sloupy od desky (vrstva 0) po vrchní vrstvu s podpěrou
  for (const p of pillars) {
    for (let li = 0; li <= p.top; li++) {
      const r = li === p.top ? tip : radius;
      fillCircle(layers[li], p.x, p.y, r, W, H);
    }
  }

  return {
    ...slice,
    layers: layers.map(
      (data, index) => ({ index, z: slice.layers[index].z, data })
    ),
  };
}
