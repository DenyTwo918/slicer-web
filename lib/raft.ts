import type { SliceResult } from "./slice";

export interface RaftOptions {
  enabled: boolean;
  /** počet vrstev raftu */
  layers: number;
  /** přesah raftu kolem modelu v mm */
  marginMm: number;
}

export interface RaftResult {
  result: SliceResult;
  /** maska raftu — 1 = pixel raftu (per vrstva) */
  mask: Uint8Array[];
}

/** Exact separable box dilation with independent physical X/Y radii. */
function dilateFootprint(
  src: Uint8Array,
  width: number,
  height: number,
  radiusX: number,
  radiusY: number,
): Uint8Array {
  const horizontal = new Uint8Array(width * height);
  const out = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let filled = 0;
    for (let x = 0; x <= Math.min(width - 1, radiusX); x++) filled += src[row + x] ? 1 : 0;
    for (let x = 0; x < width; x++) {
      if (filled > 0) horizontal[row + x] = 1;
      const leaving = x - radiusX;
      const entering = x + radiusX + 1;
      if (leaving >= 0) filled -= src[row + leaving] ? 1 : 0;
      if (entering < width) filled += src[row + entering] ? 1 : 0;
    }
  }

  for (let x = 0; x < width; x++) {
    let filled = 0;
    for (let y = 0; y <= Math.min(height - 1, radiusY); y++) filled += horizontal[y * width + x];
    for (let y = 0; y < height; y++) {
      if (filled > 0) out[y * width + x] = 1;
      const leaving = y - radiusY;
      const entering = y + radiusY + 1;
      if (leaving >= 0) filled -= horizontal[leaving * width + x];
      if (entering < height) filled += horizontal[entering * width + x];
    }
  }
  return out;
}

/**
 * Raft — plochá základna pod modelem pro lepší přilnavost k desce.
 * Vezme otisk spodní vrstvy, rozšíří o margin a vyplní první vrstvy.
 * Vrací i masku přidaných pixelů.
 */
export function applyRaft(
  slice: SliceResult,
  opts: RaftOptions,
  mmPerPx: { x: number; y: number }
): RaftResult {
  if (!opts.enabled || slice.layers.length === 0) {
    return { result: slice, mask: slice.layers.map(() => new Uint8Array(0)) };
  }
  const W = slice.resolutionX;
  const H = slice.resolutionY;
  const marginPxX = Math.max(1, Math.round(opts.marginMm / mmPerPx.x));
  const marginPxY = Math.max(1, Math.round(opts.marginMm / mmPerPx.y));

  // otisk = sjednocení spodních vrstev (do max 2 mm, nebo 8 % výšky).
  // U nakloněných modelů se deska dotýká jen částí — první vrstva by dala
  // mini-raft; sjednocený pás pod modelem dá raft kolem celé spodní strany.
  const totalH = slice.layers.length * slice.layerHeight;
  const bandMm = Math.max(2, totalH * 0.08);
  const bandCount = Math.min(
    slice.layers.length,
    Math.ceil(bandMm / slice.layerHeight)
  );
  const footprint = new Uint8Array(W * H);
  for (let i = 0; i < bandCount; i++) {
    const l = slice.layers[i].data;
    for (let p = 0; p < l.length; p++) {
      if (l[p]) footprint[p] = 1;
    }
  }

  const raft = dilateFootprint(footprint, W, H, marginPxX, marginPxY);

  const layers = slice.layers.map((l) => new Uint8Array(l.data));
  const raftCount = Math.min(opts.layers, layers.length);
  const mask = slice.layers.map((_, i) =>
    i < raftCount ? new Uint8Array(W * H) : new Uint8Array(0)
  );
  for (let i = 0; i < raftCount; i++) {
    for (let p = 0; p < W * H; p++) {
      if (raft[p]) {
        layers[i][p] = 1;
        mask[i][p] = 1;
      }
    }
  }

  return {
    result: {
      ...slice,
      layers: layers.map((data, index) => ({ index, z: slice.layers[index].z, data })),
    },
    mask,
  };
}
