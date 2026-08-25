import type { SliceResult } from "./slice";

export interface RaftOptions {
  enabled: boolean;
  /** počet vrstev raftu */
  layers: number;
  /** přesah raftu kolem modelu v mm */
  marginMm: number;
}

/**
 * Raft — plochá základna pod modelem pro lepší přilnavost k desce.
 * Vezme otisk spodní vrstvy, rozšíří o margin a vyplní první vrstvy.
 */
export function applyRaft(
  slice: SliceResult,
  opts: RaftOptions,
  mmPerPx: { x: number; y: number }
): SliceResult {
  if (!opts.enabled || slice.layers.length === 0) return slice;
  const W = slice.resolutionX;
  const H = slice.resolutionY;
  const px = Math.min(mmPerPx.x, mmPerPx.y);
  const marginPx = Math.max(1, Math.round(opts.marginMm / px));

  // otisk = spodní vrstva (první s pixely)
  let bottomIdx = 0;
  for (let i = 0; i < slice.layers.length; i++) {
    const l = slice.layers[i].data;
    let has = false;
    for (let p = 0; p < l.length; p++) {
      if (l[p]) {
        has = true;
        break;
      }
    }
    if (has) {
      bottomIdx = i;
      break;
    }
  }
  const footprint = slice.layers[bottomIdx].data;

  // rozšířit (box dilate o marginPx)
  const raft = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!footprint[y * W + x]) continue;
      const x0 = Math.max(0, x - marginPx);
      const x1 = Math.min(W - 1, x + marginPx);
      const y0 = Math.max(0, y - marginPx);
      const y1 = Math.min(H - 1, y + marginPx);
      for (let yy = y0; yy <= y1; yy++) {
        raft.fill(1, yy * W + x0, yy * W + x1 + 1);
      }
    }
  }

  const layers = slice.layers.map((l) => new Uint8Array(l.data));
  const raftCount = Math.min(opts.layers, layers.length);
  for (let i = 0; i < raftCount; i++) {
    for (let p = 0; p < W * H; p++) {
      if (raft[p]) layers[i][p] = 1;
    }
  }

  return {
    ...slice,
    layers: layers.map((data, index) => ({ index, z: slice.layers[index].z, data })),
  };
}
