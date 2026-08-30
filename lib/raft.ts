import type { SliceResult } from "./slice";

export interface RaftOptions {
  enabled: boolean;
  /** počet vrstev raftu */
  layers: number;
  /** přesah raftu kolem modelu v mm */
  marginMm: number;
  /** zvýšený obvodový lem („vanička") pro zapření špachtle */
  rimEnabled?: boolean;
  /** celková radiální šířka lemu v mm */
  rimWidthMm?: number;
  /** výška lemu nad plným dnem raftu v mm */
  rimHeightMm?: number;
}

export interface RaftResult {
  result: SliceResult;
  /** maska raftu — 1 = pixel raftu (per vrstva) */
  mask: Uint8Array[];
}

export interface NormalizedRaftRim {
  enabled: boolean;
  widthMm: number;
  heightMm: number;
}

/** One validation rule shared by preview slicing and native export. */
export function normalizeRaftRim(
  enabled: boolean | undefined,
  widthMm: number | undefined,
  heightMm: number | undefined,
): NormalizedRaftRim {
  const width = Number.isFinite(widthMm) ? widthMm! : 0;
  const height = Number.isFinite(heightMm) ? heightMm! : 0;
  const active = enabled === true && width > 0 && height > 0;
  return active
    ? { enabled: true, widthMm: width, heightMm: height }
    : { enabled: false, widthMm: 0, heightMm: 0 };
}

/** Lower Z band used as the footprint source by both slicing paths. */
export function raftFootprintBandLayers(layerCount: number, layerHeight: number): number {
  if (layerCount <= 0 || layerHeight <= 0) return 0;
  const totalH = layerCount * layerHeight;
  return Math.min(layerCount, Math.ceil(Math.max(2, totalH * 0.08) / layerHeight));
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
  const bandCount = raftFootprintBandLayers(slice.layers.length, slice.layerHeight);
  const footprint = new Uint8Array(W * H);
  for (let i = 0; i < bandCount; i++) {
    const l = slice.layers[i].data;
    for (let p = 0; p < l.length; p++) {
      if (l[p]) footprint[p] = 1;
    }
  }

  const layers = slice.layers.map((l) => new Uint8Array(l.data));
  const raftCount = Math.min(opts.layers, layers.length);
  const rim = normalizeRaftRim(opts.rimEnabled, opts.rimWidthMm, opts.rimHeightMm);
  const rimCount = rim.enabled
    ? Math.min(layers.length - raftCount, Math.ceil(rim.heightMm / slice.layerHeight))
    : 0;
  const mask = slice.layers.map((_, i) =>
    i < raftCount + rimCount ? new Uint8Array(W * H) : new Uint8Array(0)
  );

  const innerRaft = dilateFootprint(footprint, W, H, marginPxX, marginPxY);
  const rimPxX = rim.enabled ? Math.max(1, Math.round(rim.widthMm / mmPerPx.x)) : 0;
  const rimPxY = rim.enabled ? Math.max(1, Math.round(rim.widthMm / mmPerPx.y)) : 0;
  const topOuterX = marginPxX + Math.ceil(rimPxX / 2);
  const topOuterY = marginPxY + Math.ceil(rimPxY / 2);
  const bottomOuterX = marginPxX + rimPxX;
  const bottomOuterY = marginPxY + rimPxY;
  const rimOuter = rim.enabled
    ? dilateFootprint(footprint, W, H, topOuterX, topOuterY)
    : innerRaft;

  for (let i = 0; i < raftCount; i++) {
    const t = raftCount <= 1 ? 0 : i / (raftCount - 1);
    const radiusX = rim.enabled
      ? Math.round(bottomOuterX + (topOuterX - bottomOuterX) * t)
      : marginPxX;
    const radiusY = rim.enabled
      ? Math.round(bottomOuterY + (topOuterY - bottomOuterY) * t)
      : marginPxY;
    const raft = radiusX === marginPxX && radiusY === marginPxY
      ? innerRaft
      : dilateFootprint(footprint, W, H, radiusX, radiusY);
    for (let p = 0; p < W * H; p++) {
      if (raft[p]) {
        layers[i][p] = 1;
        mask[i][p] = 1;
      }
    }
  }
  for (let i = raftCount; i < raftCount + rimCount; i++) {
    for (let p = 0; p < W * H; p++) {
      if (rimOuter[p] && !innerRaft[p]) {
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
