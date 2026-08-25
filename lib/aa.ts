import type { SliceResult } from "./slice";

/**
 * Anti-aliasing — 3×3 box blur binárního rastru → šedé hodnoty (0..255).
 * Zjemní schody na hranách; RLE4 (pw0Img) barvy 0..15 zvládá nativně.
 */
export function applyAA(slice: SliceResult): SliceResult {
  const W = slice.resolutionX;
  const H = slice.resolutionY;
  const layers = slice.layers.map((l) => {
    const src = l.data;
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(H - 1, y + 1);
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - 1);
        const x1 = Math.min(W - 1, x + 1);
        let sum = 0;
        for (let yy = y0; yy <= y1; yy++) {
          const row = yy * W;
          for (let xx = x0; xx <= x1; xx++) {
            sum += src[row + xx];
          }
        }
        // 9 úrovní šedi (0..255)
        out[y * W + x] = Math.round((sum / 9) * 255);
      }
    }
    return { index: l.index, z: l.z, data: out };
  });
  return { ...slice, layers };
}
