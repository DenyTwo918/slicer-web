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
  minPrintableWidthMm = 0,
): NormalizedRaftRim {
  const width = Number.isFinite(widthMm) ? widthMm! : 0;
  const height = Number.isFinite(heightMm) ? heightMm! : 0;
  const active = enabled === true && width > 0 && height > 0;
  return active
    ? { enabled: true, widthMm: Math.max(width, minPrintableWidthMm), heightMm: height }
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

interface BinaryMaskRuns {
  rows: Array<Array<[number, number]>>;
}

interface PhysicalOffsetKernel {
  key: string;
  rows: Array<{ dy: number; dx: number }>;
}

function buildBinaryMaskRuns(src: Uint8Array, width: number, height: number): BinaryMaskRuns {
  const rows: BinaryMaskRuns["rows"] = Array.from({ length: height }, () => []);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let x = 0;
    while (x < width) {
      while (x < width && !src[row + x]) x++;
      if (x >= width) break;
      const x0 = x++;
      while (x < width && src[row + x]) x++;
      rows[y].push([x0, x - 1]);
    }
  }
  return { rows };
}

function buildPhysicalOffsetKernel(radiusX: number, radiusY: number): PhysicalOffsetKernel {
  const rx = Math.max(0, radiusX);
  const ry = Math.max(0, radiusY);
  const rows: PhysicalOffsetKernel["rows"] = [];
  const maxDy = Math.ceil(ry);
  for (let dy = -maxDy; dy <= maxDy; dy++) {
    const normalizedY = ry > 0 ? dy / ry : dy === 0 ? 0 : Infinity;
    if (Math.abs(normalizedY) > 1) continue;
    const dx = Math.floor(rx * Math.sqrt(Math.max(0, 1 - normalizedY * normalizedY)) + 1e-9);
    rows.push({ dy, dx });
  }
  return {
    key: rows.map(({ dy, dx }) => `${dy}:${dx}`).join(","),
    rows,
  };
}

/** Physical elliptical run offset used for the 45° rise. */
function offsetBinaryMaskRuns(
  source: BinaryMaskRuns,
  src: Uint8Array,
  width: number,
  height: number,
  kernel: PhysicalOffsetKernel,
): Uint8Array {
  if (kernel.rows.length === 1 && kernel.rows[0].dy === 0 && kernel.rows[0].dx === 0) return src;
  const out = new Uint8Array(width * height);
  const intervals: Array<[number, number]> = [];
  for (let y = 0; y < height; y++) {
    intervals.length = 0;
    for (const { dy, dx } of kernel.rows) {
      const sourceY = y - dy;
      if (sourceY < 0 || sourceY >= height) continue;
      for (const [x0, x1] of source.rows[sourceY]) {
        intervals.push([Math.max(0, x0 - dx), Math.min(width - 1, x1 + dx)]);
      }
    }
    intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let start = -1;
    let end = -1;
    for (const [x0, x1] of intervals) {
      if (start < 0) {
        start = x0;
        end = x1;
      } else if (x0 <= end + 1) {
        end = Math.max(end, x1);
      } else {
        out.fill(1, y * width + start, y * width + end + 1);
        start = x0;
        end = x1;
      }
    }
    if (start >= 0) out.fill(1, y * width + start, y * width + end + 1);
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
  // A 45° wall moves by one layer height per layer. It needs at least twice
  // that thickness so adjacent annuli retain a printable overlap, not four
  // accidental corner pixels only.
  const rim = normalizeRaftRim(
    opts.rimEnabled,
    opts.rimWidthMm,
    opts.rimHeightMm,
    slice.layerHeight * 2,
  );
  const rimCount = rim.enabled
    ? Math.min(layers.length - raftCount, Math.ceil(rim.heightMm / slice.layerHeight))
    : 0;
  const mask = slice.layers.map((_, i) =>
    i < raftCount + rimCount ? new Uint8Array(W * H) : new Uint8Array(0)
  );

  const innerRaft = dilateFootprint(footprint, W, H, marginPxX, marginPxY);
  // A one-pixel annulus can disappear completely when the accumulated 45°
  // shift crosses a pixel boundary. Keep one extra pixel beyond the largest
  // possible per-layer quantized shift so neighbouring layers always overlap.
  const minRimPxX = Math.ceil(slice.layerHeight / mmPerPx.x) + 1;
  const minRimPxY = Math.ceil(slice.layerHeight / mmPerPx.y) + 1;
  const rimPxX = rim.enabled ? Math.max(minRimPxX, Math.round(rim.widthMm / mmPerPx.x)) : 0;
  const rimPxY = rim.enabled ? Math.max(minRimPxY, Math.round(rim.widthMm / mmPerPx.y)) : 0;
  const rimBaseOuterX = marginPxX + rimPxX;
  const rimBaseOuterY = marginPxY + rimPxY;
  const floorRaft = rim.enabled
    ? dilateFootprint(footprint, W, H, rimBaseOuterX, rimBaseOuterY)
    : innerRaft;
  const innerRuns = rim.enabled ? buildBinaryMaskRuns(innerRaft, W, H) : null;
  const outerRuns = rim.enabled ? buildBinaryMaskRuns(floorRaft, W, H) : null;
  const innerOffsetCache = new Map<string, Uint8Array>();
  const outerOffsetCache = new Map<string, Uint8Array>();

  for (let i = 0; i < raftCount; i++) {
    for (let p = 0; p < W * H; p++) {
      if (floorRaft[p]) {
        layers[i][p] = 1;
        mask[i][p] = 1;
      }
    }
  }
  for (let i = raftCount; i < raftCount + rimCount; i++) {
    const rimLayer = i - raftCount;
    // 45° ven: vodorovný posun je přesně stejný jako fyzický vzestup vrstvy.
    const riseMm = rimLayer * slice.layerHeight;
    const risePxX = riseMm / mmPerPx.x;
    const risePxY = riseMm / mmPerPx.y;
    const kernel = buildPhysicalOffsetKernel(risePxX, risePxY);
    let rimInner = innerOffsetCache.get(kernel.key);
    if (!rimInner) {
      rimInner = offsetBinaryMaskRuns(innerRuns!, innerRaft, W, H, kernel);
      innerOffsetCache.set(kernel.key, rimInner);
    }
    let rimOuter = outerOffsetCache.get(kernel.key);
    if (!rimOuter) {
      rimOuter = offsetBinaryMaskRuns(outerRuns!, floorRaft, W, H, kernel);
      outerOffsetCache.set(kernel.key, rimOuter);
    }
    for (let p = 0; p < W * H; p++) {
      if (rimOuter[p] && !rimInner[p]) {
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
