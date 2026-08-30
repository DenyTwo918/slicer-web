import type { PipelineModel } from "./pipeline";
import type { PipelineSettings } from "./pipeline";
import type { PrinterProfile } from "./profiles";
import type { SliceResult } from "./slice";
import type { DrainAnchor } from "./hollow";
import {
  initNative,
  nativeReady,
  fullDepthRegion,
} from "./native";
import { detectSupportAnchors } from "./supportDetect";
import {
  placeSupports,
  crossBraceLines,
  braceLineFree,
  type PillarCtx,
  type PlacedPillar,
  type BraceLine,
} from "./supports";
import {
  encodeLayerCropToMachineInternal,
  encodeSceneSlice,
  buildPwsp,
  buildLayersControllerFrom,
  buildPrintInfo,
  type SceneLayerInfo,
  type Pm7Options,
} from "./pm7";
import { normalizeRaftRim, raftFootprintBandLayers } from "./raft";

/**
 * Full-res (12K) streaming export.
 *
 * Slicování náhledu běží na 1/16 rozlišení kvůli paměti (~550 MB). Pro skutečný
 * tisk ale chceme nativních 11520×5120 px. Postup:
 *  1) CPU rasterizace meshí do front/back depth map na plném rozlišení
 *     (uint16 kvantizace — 3,5 µm přesnosti), PŘÍMO do wasm paměti
 *  2) vrstva po vrstvě: fill_between16 (WASM) → bitmapa je VIEW do wasm paměti
 *     → podpory se dokreslí z tras → RLE4 stream (scale 1) → bitmapa zahodí
 *  3) paměť: konstantní ~300 MB bez ohledu na počet vrstev
 *
 * Omezení v1: AA se ve full-res nepoužívá (nativní pixely), podpory se routují
 * na slicovacím rozlišení a přenásobí (kompromis).
 */

export interface FullResResult {
  bytes: Uint8Array;
  layers: number;
}

interface DepthInfo {
  zMin: number;
  zRange: number;
  kScale: number;
}

interface RasterLayer {
  data: Uint8Array;
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FullResRaftRuns {
  /** Offset into `spans` for every row; spans are inclusive x0/x1 pairs. */
  rowOffsets: Uint32Array;
  spans: Uint16Array;
}

export interface FullResRaftPlanOptions {
  floorLayers: number;
  marginX: number;
  marginY: number;
  rimEnabled: boolean;
  rimWidthX: number;
  rimWidthY: number;
  rimLayers: number;
  /** Highest sampled lower-band Z value included in the raft footprint. */
  footprintZQMax?: number;
  /** Native row spans contributed by support feet/braces in the same band. */
  extraFootprintRows?: ReadonlyMap<number, Uint16Array>;
}

export interface FullResRaftPlan {
  floorRuns: FullResRaftRuns[];
  rimOuter: FullResRaftRuns | null;
  rimInner: FullResRaftRuns | null;
  rimLayers: number;
}

/**
 * Exact box-dilated first-layer footprint encoded as row spans.
 *
 * Only (2r+1) horizontally-dilated rows are retained. This avoids both the
 * native 5*n scratch layout and a Uint32 index for every raft pixel; a smooth
 * dense raft is represented by one x0/x1 pair per row.
 */
export function buildFullResRaftRuns(
  front: Uint16Array,
  back: Uint16Array,
  zq: number,
  width: number,
  height: number,
  radiusX: number,
  radiusY: number,
  source?: Pick<FullResRaftPlanOptions, "footprintZQMax" | "extraFootprintRows">,
): FullResRaftRuns {
  const n = width * height;
  if (front.length < n || back.length < n) throw new Error("Full-res raft depth map is too small.");
  if (width > 65536) throw new Error("Full-res raft row spans require width <= 65536.");
  const rx = Math.max(0, Math.trunc(radiusX));
  const ry = Math.max(0, Math.trunc(radiusY));
  const footprintZQMax = source?.footprintZQMax ?? zq;
  const extraRowMask = source?.extraFootprintRows ? new Uint8Array(width) : null;
  const ringRows = Math.min(height, ry * 2 + 1);
  const horizontalRing = new Uint8Array(ringRows * width);
  const verticalCounts = new Uint32Array(width);
  const rowOffsets = new Uint32Array(height + 1);
  let spans = new Uint16Array(Math.max(16, height * 4));
  let spanLength = 0;

  const appendSpan = (x0: number, x1: number) => {
    if (spanLength + 2 > spans.length) {
      const grown = new Uint16Array(spans.length * 2);
      grown.set(spans);
      spans = grown;
    }
    spans[spanLength++] = x0;
    spans[spanLength++] = x1;
  };

  // Continue for ry virtual rows so bottom-edge output rows see their clipped
  // vertical window, just like the reference box dilation.
  for (let sourceY = 0; sourceY < height + ry; sourceY++) {
    const leavingY = sourceY - (ry * 2 + 1);
    if (leavingY >= 0 && leavingY < height) {
      const leavingRow = (leavingY % ringRows) * width;
      for (let x = 0; x < width; x++) verticalCounts[x] -= horizontalRing[leavingRow + x];
    }

    if (sourceY < height) {
      const ringRow = (sourceY % ringRows) * width;
      horizontalRing.fill(0, ringRow, ringRow + width);
      const sourceRow = sourceY * width;
      if (extraRowMask) {
        extraRowMask.fill(0);
        const spans = source?.extraFootprintRows?.get(sourceY);
        if (spans) {
          for (let k = 0; k < spans.length; k += 2) {
            extraRowMask.fill(1, spans[k], spans[k + 1] + 1);
          }
        }
      }
      let filled = 0;
      for (let x = 0; x <= Math.min(width - 1, rx); x++) {
        const p = sourceRow + x;
        if ((front[p] < footprintZQMax && zq < back[p]) || extraRowMask?.[x]) filled++;
      }
      for (let x = 0; x < width; x++) {
        const value = filled > 0 ? 1 : 0;
        horizontalRing[ringRow + x] = value;
        verticalCounts[x] += value;
        const removeX = x - rx;
        const addX = x + rx + 1;
        if (removeX >= 0) {
          const p = sourceRow + removeX;
          if ((front[p] < footprintZQMax && zq < back[p]) || extraRowMask?.[removeX]) filled--;
        }
        if (addX < width) {
          const p = sourceRow + addX;
          if ((front[p] < footprintZQMax && zq < back[p]) || extraRowMask?.[addX]) filled++;
        }
      }
    }

    const outputY = sourceY - ry;
    if (outputY < 0 || outputY >= height) continue;
    rowOffsets[outputY] = spanLength;
    let x = 0;
    while (x < width) {
      while (x < width && verticalCounts[x] === 0) x++;
      if (x >= width) break;
      const x0 = x++;
      while (x < width && verticalCounts[x] !== 0) x++;
      appendSpan(x0, x - 1);
    }
    rowOffsets[outputY + 1] = spanLength;
  }

  return { rowOffsets, spans: spans.slice(0, spanLength) };
}

/** Layer-dependent full-resolution raft: tapered floor plus raised perimeter. */
export function buildFullResRaftPlan(
  front: Uint16Array,
  back: Uint16Array,
  zq: number,
  width: number,
  height: number,
  opts: FullResRaftPlanOptions,
): FullResRaftPlan {
  const floorLayers = Math.max(0, Math.trunc(opts.floorLayers));
  const marginX = Math.max(0, Math.trunc(opts.marginX));
  const marginY = Math.max(0, Math.trunc(opts.marginY));
  const rimEnabled = opts.rimEnabled && opts.rimWidthX > 0 && opts.rimWidthY > 0 && opts.rimLayers > 0;
  const rimWidthX = rimEnabled ? Math.max(1, Math.trunc(opts.rimWidthX)) : 0;
  const rimWidthY = rimEnabled ? Math.max(1, Math.trunc(opts.rimWidthY)) : 0;
  const topOuterX = marginX + Math.ceil(rimWidthX / 2);
  const topOuterY = marginY + Math.ceil(rimWidthY / 2);
  const bottomOuterX = marginX + rimWidthX;
  const bottomOuterY = marginY + rimWidthY;
  const cache = new Map<string, FullResRaftRuns>();
  const runsFor = (rx: number, ry: number) => {
    const key = `${rx}:${ry}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const runs = buildFullResRaftRuns(front, back, zq, width, height, rx, ry, opts);
    cache.set(key, runs);
    return runs;
  };
  const floorRuns = Array.from({ length: floorLayers }, (_, i) => {
    const t = floorLayers <= 1 ? 0 : i / (floorLayers - 1);
    const rx = rimEnabled
      ? Math.round(bottomOuterX + (topOuterX - bottomOuterX) * t)
      : marginX;
    const ry = rimEnabled
      ? Math.round(bottomOuterY + (topOuterY - bottomOuterY) * t)
      : marginY;
    return runsFor(rx, ry);
  });
  return {
    floorRuns,
    rimOuter: rimEnabled ? runsFor(topOuterX, topOuterY) : null,
    rimInner: rimEnabled ? runsFor(marginX, marginY) : null,
    rimLayers: rimEnabled ? Math.max(0, Math.trunc(opts.rimLayers)) : 0,
  };
}

function buildSupportFootprintRows(
  width: number,
  height: number,
  bandLayers: number,
  pillarsByLayer: ReadonlyMap<number, { x: number; y: number; r: number }[]>,
  bracesByLayer: ReadonlyMap<number, { x: number; y: number; r: number }[]>,
): Map<number, Uint16Array> {
  const pending = new Map<number, Array<[number, number]>>();
  const addCircle = ({ x, y, r }: { x: number; y: number; r: number }) => {
    const cx = Math.round(x);
    const cy = Math.round(y);
    const radius = Math.max(0, Math.trunc(r));
    for (let yy = Math.max(0, cy - radius); yy <= Math.min(height - 1, cy + radius); yy++) {
      const dy = yy - cy;
      const dx = Math.floor(Math.sqrt(Math.max(0, radius * radius - dy * dy)));
      const row = pending.get(yy) ?? [];
      row.push([Math.max(0, cx - dx), Math.min(width - 1, cx + dx)]);
      pending.set(yy, row);
    }
  };
  for (let layer = 0; layer < bandLayers; layer++) {
    for (const circle of pillarsByLayer.get(layer) ?? []) addCircle(circle);
    for (const circle of bracesByLayer.get(layer) ?? []) addCircle(circle);
  }
  const mergedRows = new Map<number, Uint16Array>();
  for (const [y, intervals] of pending) {
    intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: number[] = [];
    for (const [x0, x1] of intervals) {
      const last = merged.length - 2;
      if (last >= 0 && x0 <= merged[last + 1] + 1) {
        merged[last + 1] = Math.max(merged[last + 1], x1);
      } else {
        merged.push(x0, x1);
      }
    }
    mergedRows.set(y, Uint16Array.from(merged));
  }
  return mergedRows;
}

/**
 * Přesná 2D box eroze sloučená s aktualizací Z běhů. Horizontální výsledky
 * drží jen (2r+1) řádků; vertikální součty mají jeden prvek na sloupec.
 * Na rozdíl od dvou plných scratch bitmap tak vrstvu projde JS jen jednou.
 */
function advanceErodedRuns(
  src: Uint8Array,
  width: number,
  height: number,
  radiusX: number,
  radiusY: number,
  horizontalRows: Uint8Array,
  verticalCounts: Uint16Array,
  zRun: Uint8Array | Uint16Array
) {
  const spanX = radiusX * 2 + 1;
  const spanY = radiusY * 2 + 1;
  horizontalRows.fill(0);
  verticalCounts.fill(0);
  if (spanX > width || spanY > height) {
    zRun.fill(0);
    return;
  }
  for (let y = 0; y < height; y++) {
    const srcRow = y * width;
    const ringRow = (y % spanY) * width;
    let filled = 0;
    for (let x = 0; x < spanX; x++) filled += src[srcRow + x] ? 1 : 0;
    for (let x = radiusX; x < width - radiusX; x++) {
      const old = horizontalRows[ringRow + x];
      const horizontal = filled === spanX ? 1 : 0;
      horizontalRows[ringRow + x] = horizontal;
      verticalCounts[x] += horizontal - old;
      if (y >= spanY - 1) {
        const p = (y - radiusY) * width + x;
        zRun[p] = verticalCounts[x] === spanY
          ? Math.min(zRun.BYTES_PER_ELEMENT === 1 ? 255 : 65535, zRun[p] + 1)
          : 0;
      }
      const leaving = x - radiusX;
      const entering = x + radiusX + 1;
      if (entering < width) {
        filled -= src[srcRow + leaving] ? 1 : 0;
        filled += src[srcRow + entering] ? 1 : 0;
      }
    }
  }
}

/**
 * Streamovatelný přesný 3D hollowing pro full-res vrstvy.
 *
 * Původní export odvozoval dutinu pouze z nejnižšího a nejvyššího průsečíku
 * paprsku (`front/back`). To zalévalo okna a kabiny a vytvářelo falešné stěny.
 * Tato varianta bere skutečný even-odd řez každé vrstvy a aplikuje stejnou 3D
 * box erozi jako náhled. Z-okno není uložené jako 81 plných 12K bitmap: průběžná
 * délka běhu určí průnik v Z. Solidní střed znovu vytvoří druhý sekvenční sweep;
 * to je levnější než držet stovky MiB packed vrstev a nemění even-odd význam.
 */
export function createStreamingHollowRasterizer(
  rasterizeSolid: (layerIndex: number) => RasterLayer,
  width: number,
  height: number,
  layerCount: number,
  wallRadiusX: number,
  wallRadiusY: number,
  wallLayers: number,
  materializeSolid: (
    layerIndex: number,
    coreRuns?: Uint8Array | Uint16Array,
    coreThreshold?: number
  ) => RasterLayer
): (layerIndex: number) => RasterLayer {
  const n = width * height;
  const radiusX = Math.max(1, Math.trunc(wallRadiusX));
  const radiusY = Math.max(1, Math.trunc(wallRadiusY));
  const radiusZ = Math.max(1, Math.trunc(wallLayers));
  const fullWindow = radiusZ * 2 + 1;
  const yWindow = radiusY * 2 + 1;
  const horizontalRows = new Uint8Array(Math.min(height, yWindow) * width);
  const verticalCounts = new Uint16Array(width);
  const zRun: Uint8Array | Uint16Array = fullWindow <= 255
    ? new Uint8Array(n)
    : new Uint16Array(n);
  let processed = -1;
  let requested = -1;

  const materialize = (index: number, removeCore: boolean): RasterLayer => {
    return removeCore
      ? materializeSolid(index, zRun, fullWindow)
      : materializeSolid(index);
  };

  const processThrough = (last: number) => {
    while (processed < last) {
      processed++;
      const solid = rasterizeSolid(processed);
      advanceErodedRuns(
        solid.data, width, height, radiusX, radiusY,
        horizontalRows, verticalCounts, zRun
      );
    }
  };

  return (layerIndex: number) => {
    if (layerIndex < 0 || layerIndex >= layerCount) {
      throw new Error(`Full-res hollow vrstva ${layerIndex} je mimo rozsah.`);
    }
    if (layerIndex !== requested + 1) {
      throw new Error("Full-res hollow vrstvy musí být čteny postupně.");
    }
    requested = layerIndex;
    processThrough(Math.min(layerCount - 1, layerIndex + radiusZ));
    const complete = layerIndex >= radiusZ && layerIndex + radiusZ < layerCount;
    return materialize(layerIndex, complete);
  };
}

/**
 * Přesný vektorový průřez pro full-res export. Depth mapa umí jen jeden Z
 * interval na paprsek a u Benchy by zalila kabinu/dutiny. Sweep drží aktivní
 * trojúhelníky podle Z a každou vrstvu vyplní even-odd stejně jako CPU náhled.
 */
function createExactRasterizer(
  models: PipelineModel[],
  printer: PrinterProfile,
  zStart: number,
  layerHeight: number,
  layerCount: number
) {
  const W = printer.resX;
  const H = printer.resY;
  const pxX = W / printer.printX;
  const pxY = H / printer.printY;
  const states = models.map((m) => {
    const starts: number[][] = Array.from({ length: layerCount }, () => []);
    const ends: number[][] = Array.from({ length: layerCount + 1 }, () => []);
    for (let t = 0; t < m.triangleCount; t++) {
      const o = t * 9;
      const lo = Math.min(m.positions[o + 2], m.positions[o + 5], m.positions[o + 8]);
      const hi = Math.max(m.positions[o + 2], m.positions[o + 5], m.positions[o + 8]);
      const first = Math.max(0, Math.floor((lo - zStart) / layerHeight - 0.5) - 1);
      const after = Math.min(layerCount, Math.ceil((hi - zStart) / layerHeight - 0.5) + 2);
      if (first < layerCount && after > first) {
        starts[first].push(t);
        ends[after].push(t);
      }
    }
    return {
      model: m,
      starts,
      ends,
      active: new Set<number>(),
      ox: (printer.printX - (m.bounds.max[0] - m.bounds.min[0])) / 2 - m.bounds.min[0] + m.tx,
      oy: (printer.printY - (m.bounds.max[1] - m.bounds.min[1])) / 2 - m.bounds.min[1] + m.ty,
    };
  });
  // Jeden buffer na sweep. Volající výsledek spotřebuje před dalším krokem;
  // 12K ArrayBuffer proto nemusí pro každou vrstvu znovu alokovat a čekat na GC.
  const data = new Uint8Array(W * H);

  return (
    layerIndex: number,
    z: number,
    coreRuns?: Uint8Array | Uint16Array,
    coreThreshold = 0
  ) => {
    data.fill(0);
    let count = 0;
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (const state of states) {
      for (const t of state.ends[layerIndex]) state.active.delete(t);
      for (const t of state.starts[layerIndex]) state.active.add(t);
      const crossings: number[][] = Array.from({ length: H }, () => []);
      const pos = state.model.positions;
      for (const t of state.active) {
        const o = t * 9;
        const pts: [number, number][] = [];
        for (let e = 0; e < 3; e++) {
          const a = o + e * 3;
          const b = o + ((e + 1) % 3) * 3;
          const da = pos[a + 2] - z;
          const db = pos[b + 2] - z;
          if ((da < 0 && db >= 0) || (db < 0 && da >= 0)) {
            const f = da / (da - db);
            pts.push([
              (pos[a] + f * (pos[b] - pos[a]) + state.ox) * pxX,
              (pos[a + 1] + f * (pos[b + 1] - pos[a + 1]) + state.oy) * pxY,
            ]);
          }
        }
        if (pts.length !== 2) continue;
        let [x1, y1] = pts[0];
        let [x2, y2] = pts[1];
        if (y1 === y2) continue;
        if (y1 > y2) {
          [x1, x2] = [x2, x1];
          [y1, y2] = [y2, y1];
        }
        const y0 = Math.max(0, Math.floor(y1));
        const ye = Math.min(H - 1, Math.floor(y2));
        for (let row = y0; row <= ye; row++) {
          const yy = row + 0.5;
          if (yy < y1 || yy > y2) continue;
          crossings[row].push(x1 + ((yy - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      for (let y = 0; y < H; y++) {
        const xs = crossings[y].sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const x0 = Math.max(0, Math.ceil(xs[k]));
          const x1 = Math.min(W - 1, Math.floor(xs[k + 1]));
          if (x1 < x0) continue;
          const row = y * W;
          for (let x = x0; x <= x1; x++) {
            const p = row + x;
            if (!data[p] && (!coreRuns || coreRuns[p] < coreThreshold)) {
              data[p] = 255;
              count++;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
      }
    }
    return { data, count, minX, minY, maxX, maxY };
  };
}

/** CPU rasterizace meshí do uint16 depth map (přímo do wasm paměti). */
function rasterizeDepthFull(
  models: PipelineModel[],
  printer: PrinterProfile,
  layerHeight: number,
  heapBacked = false
): DepthInfo & { front: Uint16Array<ArrayBuffer>; back: Uint16Array<ArrayBuffer> } {
  const resX = printer.resX;
  const resY = printer.resY;
  const n = resX * resY;

  let zMin = Infinity;
  let zMax = -Infinity;
  for (const m of models) {
    zMin = Math.min(zMin, m.bounds.min[2]);
    zMax = Math.max(zMax, m.bounds.max[2]);
  }
  const zRange = Math.max(zMax - zMin, 1e-6);
  // kvantizace: 0..65535 přes výšku modelu (3,5 µm při 230 mm)
  const kScale = 65535 / zRange;

  // Hollow export používá exact even-odd řezy a fill_between16 nepotřebuje.
  // Jeho depth mapy proto nesmí aktivovat historický 19*n WASM layout
  // (scratch + float-depth + full-depth), který na 12K sám přesahuje 1 GiB.
  const { front, back } = heapBacked
    ? { front: new Uint16Array(n), back: new Uint16Array(n) }
    : fullDepthRegion(n);
  front.fill(65535);
  back.fill(0);

  const pxPerMmX = resX / printer.printX;
  const pxPerMmY = resY / printer.printY;

  const edges = (
    ax: number, ay: number, bx: number, by: number, cx: number, cy: number
  ) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

  for (const m of models) {
    const centerX = (printer.printX - (m.bounds.max[0] - m.bounds.min[0])) / 2 - m.bounds.min[0];
    const centerY = (printer.printY - (m.bounds.max[1] - m.bounds.min[1])) / 2 - m.bounds.min[1];
    const ox = centerX + m.tx; // mm
    const oy = centerY + m.ty; // mm
    const pos = m.positions;

    for (let t = 0; t < m.triangleCount; t++) {
      const o = t * 9;
      const v: [number, number, number][] = [];
      for (let k = 0; k < 3; k++) {
        v.push([
          (pos[o + k * 3] + ox) * pxPerMmX,
          (pos[o + k * 3 + 1] + oy) * pxPerMmY,
          (pos[o + k * 3 + 2] - zMin) * kScale,
        ]);
      }
      const area = edges(v[0][0], v[0][1], v[1][0], v[1][1], v[2][0], v[2][1]);
      if (area === 0) continue;

      const x0 = Math.max(0, Math.floor(Math.min(v[0][0], v[1][0], v[2][0])));
      const x1 = Math.min(resX - 1, Math.ceil(Math.max(v[0][0], v[1][0], v[2][0])));
      const y0 = Math.max(0, Math.floor(Math.min(v[0][1], v[1][1], v[2][1])));
      const y1 = Math.min(resY - 1, Math.ceil(Math.max(v[0][1], v[1][1], v[2][1])));

      for (let py = y0; py <= y1; py++) {
        const cy2 = py + 0.5;
        for (let px = x0; px <= x1; px++) {
          const cx2 = px + 0.5;
          const w0 = edges(v[1][0], v[1][1], v[2][0], v[2][1], cx2, cy2);
          const w1 = edges(v[2][0], v[2][1], v[0][0], v[0][1], cx2, cy2);
          const w2 = edges(v[0][0], v[0][1], v[1][0], v[1][1], cx2, cy2);
          if (area > 0 ? (w0 >= 0 && w1 >= 0 && w2 >= 0) : (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
            const zq = ((w0 * v[0][2] + w1 * v[1][2] + w2 * v[2][2]) / area) | 0;
            const idx = py * resX + px;
            if (zq < front[idx]) front[idx] = zq;
            if (zq > back[idx]) back[idx] = zq;
          }
        }
      }
    }
  }

  return { zMin, zRange, kScale, front, back };
}

/** Sestaví full-res .pm7 (streaming po vrstvách). Běží ve workeru. */
export async function buildPm7FullRes(
  models: PipelineModel[],
  settings: PipelineSettings & { aa?: boolean },
  printer: PrinterProfile,
  _meshes: { bounds: { min: [number, number, number]; max: [number, number, number] } }[],
  opts: Pm7Options & {
    previewSlice?: SliceResult | null;
    makePreview?: (slice: SliceResult, layerIdx: number, w: number, h: number) => Promise<Uint8Array>;
    onProgress?: (done: number, total: number) => void;
    previews?: [Uint8Array, Uint8Array] | null;
    drainAnchors?: DrainAnchor[];
  } = {}
): Promise<FullResResult> {
  await initNative();
  if (!nativeReady()) throw new Error("Full-res export vyžaduje WASM.");

  if (models.length === 0) throw new Error("Žádný model k exportu.");
  if (settings.layerHeight <= 0) throw new Error("Neplatná výška vrstvy.");

  const resX = printer.resX;
  const resY = printer.resY;
  const n = resX * resY;

  let zMin = Infinity;
  let zMax = -Infinity;
  for (const m of models) {
    zMin = Math.min(zMin, m.bounds.min[2]);
    zMax = Math.max(zMax, m.bounds.max[2]);
  }
  const zRange = Math.max(zMax - zMin, 1e-6);
  const numLayers = Math.max(1, Math.ceil(zRange / settings.layerHeight));
  const topEpsilon = Math.max(1e-7, settings.layerHeight * 1e-6);
  const kScale = 65535 / zRange;

  // 1) rasterizace depth map (do wasm regionu)
  const depth = rasterizeDepthFull(models, printer, settings.layerHeight, settings.hollow);

  // sanity check: aspoň nějaké platné pixely (jinak render selhal)
  let valid = 0;
  const step = 97; // prořezaný vzorek
  let sampled = 0;
  for (let i = 0; i < n; i += step) {
    sampled++;
    if (depth.front[i] < depth.back[i]) valid++;
  }
  if (valid < sampled * 0.001) {
    throw new Error("Full-res rasterizace neproběhla správně (prázdné depth mapy).");
  }

  // 2) podpory + raft na slicovacím rozlišení (downsampled depth z full-res).
  //    Jednotná logika s náhledem: stejné kotvy, stejný routing, stejný raft.
  const scale =
    resX % 16 === 0 && resY % 16 === 0 ? 16 :
    resX % 8 === 0 && resY % 8 === 0 ? 8 :
    resX % 4 === 0 && resY % 4 === 0 ? 4 :
    resX % 2 === 0 && resY % 2 === 0 ? 2 : 1;
  const sliceW = resX / scale;
  const sliceH = resY / scale;
  const pxPerMmSlice = printer.printX / sliceW;
  const sn = sliceW * sliceH;
  const sFront = new Uint16Array(sn);
  const sBack = new Uint16Array(sn);
  for (let y = 0; y < sliceH; y++) {
    const sy = Math.min(resY - 1, y * scale + (scale >> 1));
    for (let x = 0; x < sliceW; x++) {
      const sx = Math.min(resX - 1, x * scale + (scale >> 1));
      const si = y * sliceW + x;
      sFront[si] = depth.front[sy * resX + sx];
      sBack[si] = depth.back[sy * resX + sx];
    }
  }
  // kvantovaná výška vrstvy li — stejná kScale jako full-res (lineární v z)
  const layerZQ: number[] = [];
  for (let i = 0; i < numLayers; i++) {
    const zRel = Math.min(zRange - topEpsilon, (i + 0.5) * settings.layerHeight);
    layerZQ.push(zRel * kScale);
  }

  let placed: PlacedPillar[] = [];
  let braceLines: BraceLine[] = [];
  if (settings.supports) {
    const anchors = detectSupportAnchors(models, {
      layerHeight: settings.layerHeight,
      minZ: zMin,
      resX: sliceW,
      resY: sliceH,
      printX: printer.printX,
      printY: printer.printY,
    }, {
      maxAngleDeg: settings.supportMaxAngleDeg,
      spacingMm: settings.supportSpacingMm,
      clearanceMm: settings.supportClearanceMm,
    });
    const radiusPx = Math.max(2, Math.round(settings.supportRadiusMm / pxPerMmSlice));
    const tipPx = Math.max(1, Math.round(settings.supportTipMm / pxPerMmSlice));
    const frCtx: PillarCtx = {
      N: numLayers,
      modelAt: (li, x, y) => {
        const q = layerZQ[li];
        const i = y * sliceW + x;
        return sFront[i] < q && q < sBack[i];
      },
      fill: () => {},
    };
    // Chitubox model: jen kotvy s volnou svislou cestou (blokované se přeskočí)
    placed = placeSupports(
      anchors,
      frCtx,
      radiusPx,
      tipPx,
      sliceW,
      sliceH,
      undefined,
      Math.max(1, Math.round(2.5 / settings.layerHeight)),
      pxPerMmSlice
    );
    const maxXY = Math.max(8, Math.round(15 / pxPerMmSlice));
    const braceRSlice = Math.max(1, Math.round(0.5 / pxPerMmSlice));
    braceLines = crossBraceLines(placed, maxXY).filter((line) =>
      braceLineFree(frCtx, line, braceRSlice, sliceW, sliceH)
    );
  }

  const bottomExposure = opts.bottomExposure ?? 25;
  const normalExposure = opts.normalExposure ?? 2.5;
  const bottomLayers = opts.bottomLayers ?? 5;
  const layerTimes: number[] = [];
  for (let i = 0; i < numLayers; i++) layerTimes.push(i < bottomLayers ? bottomExposure : normalExposure);

  const pxMm = printer.printX / resX;
  const pyMm = printer.printY / resY;

  // Plán otvorů vzniká nad stejným low-res hollow výsledkem, který uživatel
  // zkontroloval. Souřadnice se pouze převedou do nativních pixelů tiskárny.
  const holeRx = Math.max(1, Math.round(settings.holeDiaMm / 2 / pxMm));
  const holeRy = Math.max(1, Math.round(settings.holeDiaMm / 2 / pyMm));
  const drainPlan = settings.hollow && settings.drainHoles
    ? (opts.drainAnchors ?? []).map((anchor) => ({
        x: Math.min(resX - 1, Math.max(0, Math.round((anchor.x + 0.5) * scale - 0.5))),
        y: Math.min(resY - 1, Math.max(0, Math.round((anchor.y + 0.5) * scale - 0.5))),
        layer: Math.min(numLayers - 1, Math.max(0, anchor.layer)),
        direction: anchor.direction,
      }))
    : [];

  // sloupy podle vrstev — [vrstva] → seznam (x,y,r) ve full-res px
  const pxPerMmFull = printer.printX / resX;
  const radiusTopFull = Math.max(2, Math.round(settings.supportRadiusMm / pxPerMmFull));
  const tipFull = Math.max(1, Math.round(settings.supportTipMm / pxPerMmFull));
  const radiusBotFull = Math.round(radiusTopFull * 1.4);
  const pillarsByLayer: Map<number, { x: number; y: number; r: number }[]> = new Map();
  for (const p of placed) {
    // hlavní sloup od desky po začátek horního segmentu
    for (let li = 0; li <= p.top; li++) {
      const f = p.top > 0 ? 1 - li / p.top : 0;
      const r = Math.round(radiusTopFull + (radiusBotFull - radiusTopFull) * f);
      const arr = pillarsByLayer.get(li) ?? [];
      arr.push({ x: p.x * scale, y: p.y * scale, r });
      pillarsByLayer.set(li, arr);
    }
    // kuželový/šikmý top segment až ke skutečnému kontaktnímu bodu
    const span = Math.max(1, p.anchorLayer - p.top);
    for (let li = p.top + 1; li <= p.anchorLayer; li++) {
      const f = Math.min(1, Math.max(0, (li - p.top) / span));
      const arr = pillarsByLayer.get(li) ?? [];
      arr.push({
        x: Math.round((p.x + (p.anchorX - p.x) * f) * scale),
        y: Math.round((p.y + (p.anchorY - p.y) * f) * scale),
        r: Math.max(tipFull, Math.round(radiusTopFull + (tipFull - radiusTopFull) * f)),
      });
      pillarsByLayer.set(li, arr);
    }
  }

  // vzpěry — tenké čáry mezi sousedy (×scale)
  const braceR = Math.max(1, Math.round(0.5 / pxPerMmFull));
  const bracesByLayer: Map<number, { x: number; y: number; r: number }[]> = new Map();
  for (const L of braceLines) {
    const steps = Math.max(
      Math.abs(L.l2 - L.l1) * scale,
      Math.round(Math.hypot((L.x2 - L.x1) * scale, (L.y2 - L.y1) * scale)),
      1
    );
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const li = Math.round(L.l1 + (L.l2 - L.l1) * f);
      const cx = Math.round((L.x1 + (L.x2 - L.x1) * f) * scale);
      const cy = Math.round((L.y1 + (L.y2 - L.y1) * f) * scale);
      const arr = bracesByLayer.get(li) ?? [];
      arr.push({ x: cx, y: cy, r: braceR });
      bracesByLayer.set(li, arr);
    }
  }

  // Raft přímo v nativním rozlišení. Dřívější upscaling 1/16 masky dělal
  // viditelné 16×16 voxelové schody i v exportu.
  let raftPlan: FullResRaftPlan | null = null;
  if (settings.raft && settings.raftLayers > 0) {
    const zq0 = layerZQ[0];
    const marginFullX = Math.max(1, Math.round(settings.raftMarginMm / pxMm));
    const marginFullY = Math.max(1, Math.round(settings.raftMarginMm / pyMm));
    const rim = normalizeRaftRim(
      settings.raftRim,
      settings.raftRimWidthMm,
      settings.raftRimHeightMm,
    );
    const floorLayers = Math.min(settings.raftLayers, numLayers);
    const bandLayers = rim.enabled
      ? raftFootprintBandLayers(numLayers, settings.layerHeight)
      : 1;
    const extraFootprintRows = rim.enabled && settings.supports
      ? buildSupportFootprintRows(resX, resY, bandLayers, pillarsByLayer, bracesByLayer)
      : undefined;
    raftPlan = buildFullResRaftPlan(depth.front, depth.back, zq0, resX, resY, {
      floorLayers,
      marginX: marginFullX,
      marginY: marginFullY,
      rimEnabled: rim.enabled,
      rimWidthX: rim.enabled ? Math.max(1, Math.round(rim.widthMm / pxMm)) : 0,
      rimWidthY: rim.enabled ? Math.max(1, Math.round(rim.widthMm / pyMm)) : 0,
      rimLayers: rim.enabled
        ? Math.min(
            Math.max(0, numLayers - floorLayers),
            Math.ceil(rim.heightMm / settings.layerHeight),
          )
        : 0,
      footprintZQMax: rim.enabled ? layerZQ[Math.max(0, bandLayers - 1)] : undefined,
      extraFootprintRows,
    });
  }

  const machine = printer;
  const layerInfo: SceneLayerInfo[] = [];
  const files: Record<string, Uint8Array> = {};
  const union = models.length
    ? {
        min: [
          Math.min(...models.map((m) => m.bounds.min[0] + (printer.printX - (m.bounds.max[0] - m.bounds.min[0])) / 2 - m.bounds.min[0] + m.tx)),
          Math.min(...models.map((m) => m.bounds.min[1] + (printer.printY - (m.bounds.max[1] - m.bounds.min[1])) / 2 - m.bounds.min[1] + m.ty)),
          Math.min(...models.map((m) => m.bounds.min[2])),
        ] as [number, number, number],
        max: [
          Math.max(...models.map((m) => m.bounds.max[0] + (printer.printX - (m.bounds.max[0] - m.bounds.min[0])) / 2 - m.bounds.min[0] + m.tx)),
          Math.max(...models.map((m) => m.bounds.max[1] + (printer.printY - (m.bounds.max[1] - m.bounds.min[1])) / 2 - m.bounds.min[1] + m.ty)),
          Math.max(...models.map((m) => m.bounds.max[2])),
        ] as [number, number, number],
      }
    : { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] };
  const exactRaster = createExactRasterizer(models, printer, zMin, settings.layerHeight, numLayers);
  const hollowOutputRaster = settings.hollow
    ? createExactRasterizer(models, printer, zMin, settings.layerHeight, numLayers)
    : null;
  const hollowRaster = settings.hollow
    ? createStreamingHollowRasterizer(
        (layerIndex) => {
          const zr = Math.min(zRange - topEpsilon, (layerIndex + 0.5) * settings.layerHeight);
          return exactRaster(layerIndex, zMin + zr);
        },
        resX,
        resY,
        numLayers,
        Math.max(1, Math.round(settings.wallMm / pxMm)),
        Math.max(1, Math.round(settings.wallMm / pyMm)),
        Math.max(1, Math.ceil(settings.wallMm / settings.layerHeight)),
        (layerIndex, coreRuns, coreThreshold) => {
          const zr = Math.min(zRange - topEpsilon, (layerIndex + 0.5) * settings.layerHeight);
          return hollowOutputRaster!(layerIndex, zMin + zr, coreRuns, coreThreshold);
        }
      )
    : null;

  for (let i = 0; i < numLayers; i++) {
    const zRel = Math.min(zRange - topEpsilon, (i + 0.5) * settings.layerHeight);
    const zq = zRel * kScale;
    const res = hollowRaster
      ? hollowRaster(i)
      : exactRaster(i, zMin + zRel);

    let count = res.count;
    let minX = res.minX;
    let maxX = res.maxX;
    let minY = res.minY;
    let maxY = res.maxY;

    // podpory z tras (kruhy, přeskočit pixely modelu)
    const pil = pillarsByLayer.get(i);
    if (pil) {
      for (const c of pil) {
        const r2 = c.r * c.r;
        const x0 = Math.max(0, c.x - c.r);
        const x1 = Math.min(resX - 1, c.x + c.r);
        const y0 = Math.max(0, c.y - c.r);
        const y1 = Math.min(resY - 1, c.y + c.r);
        for (let yy = y0; yy <= y1; yy++) {
          const rowF = yy * resX;
          for (let xx = x0; xx <= x1; xx++) {
            const idx = rowF + xx;
            if (res.data[idx]) continue; // model má přednost
            const dx = xx - c.x;
            const dy = yy - c.y;
            if (dx * dx + dy * dy <= r2 && !(depth.front[idx] < zq && zq < depth.back[idx])) {
              res.data[idx] = 255;
              count++;
              if (xx < minX) minX = xx;
              if (xx > maxX) maxX = xx;
              if (yy < minY) minY = yy;
              if (yy > maxY) maxY = yy;
            }
          }
        }
      }
    }

    // příčné vzpěry (tenké čáry mezi sloupy)
    const br = bracesByLayer.get(i);
    if (br) {
      for (const c of br) {
        const r2 = c.r * c.r;
        const x0 = Math.max(0, c.x - c.r);
        const x1 = Math.min(resX - 1, c.x + c.r);
        const y0 = Math.max(0, c.y - c.r);
        const y1 = Math.min(resY - 1, c.y + c.r);
        for (let yy = y0; yy <= y1; yy++) {
          const rowF = yy * resX;
          for (let xx = x0; xx <= x1; xx++) {
            const idx = rowF + xx;
            if (res.data[idx]) continue;
            const dx = xx - c.x;
            const dy = yy - c.y;
            if (dx * dx + dy * dy <= r2 && !(depth.front[idx] < zq && zq < depth.back[idx])) {
              res.data[idx] = 255;
              count++;
              if (xx < minX) minX = xx;
              if (xx > maxX) maxX = xx;
              if (yy < minY) minY = yy;
              if (yy > maxY) maxY = yy;
            }
          }
        }
      }
    }

    // Raft jako nízká vanička: plné zkosené dno a poté jen obvodový lem.
    const floorCount = raftPlan?.floorRuns.length ?? 0;
    const raftOuter = raftPlan && i < floorCount
      ? raftPlan.floorRuns[i]
      : raftPlan && i < floorCount + raftPlan.rimLayers
        ? raftPlan.rimOuter
        : null;
    const raftInner = raftPlan && i >= floorCount && i < floorCount + raftPlan.rimLayers
      ? raftPlan.rimInner
      : null;
    if (raftOuter) {
      for (let yy = 0; yy < resY; yy++) {
        const row = yy * resX;
        let innerK = raftInner?.rowOffsets[yy] ?? 0;
        const innerEnd = raftInner?.rowOffsets[yy + 1] ?? 0;
        for (let k = raftOuter.rowOffsets[yy]; k < raftOuter.rowOffsets[yy + 1]; k += 2) {
          const x0 = raftOuter.spans[k];
          const x1 = raftOuter.spans[k + 1];
          for (let xx = x0; xx <= x1; xx++) {
            while (raftInner && innerK < innerEnd && raftInner.spans[innerK + 1] < xx) innerK += 2;
            if (raftInner && innerK < innerEnd && raftInner.spans[innerK] <= xx && xx <= raftInner.spans[innerK + 1]) {
              continue;
            }
            const idx = row + xx;
            if (!res.data[idx] && !(depth.front[idx] < zq && zq < depth.back[idx])) {
              res.data[idx] = 255;
              count++;
              if (xx < minX) minX = xx;
              if (xx > maxX) maxX = xx;
              if (yy < minY) minY = yy;
              if (yy > maxY) maxY = yy;
            }
          }
        }
      }
    }

    // Skutečné souvislé Z válce pro každou dutinu. Směr je explicitní,
    // takže více párů otvorů ani změna pořadí kotev nerozbije export.
    for (const anchor of drainPlan) {
      const active = anchor.direction === "bottom" ? i <= anchor.layer : i >= anchor.layer;
      if (!active) continue;
      const x0 = Math.max(0, anchor.x - holeRx);
      const x1 = Math.min(resX - 1, anchor.x + holeRx);
      const y0 = Math.max(0, anchor.y - holeRy);
      const y1 = Math.min(resY - 1, anchor.y + holeRy);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const dx = (xx - anchor.x) / holeRx;
          const dy = (yy - anchor.y) / holeRy;
          const index = yy * resX + xx;
          if (dx * dx + dy * dy <= 1 && res.data[index]) {
            res.data[index] = 0;
            count--;
          }
        }
      }
    }

    const areaMm2 = count * pxMm * pyMm;
    layerInfo.push({
      z: zMin + zRel,
      areaMm2,
      x0: count === 0 ? 0 : minX * pxMm,
      y0: count === 0 ? 0 : minY * pyMm,
      x1: count === 0 ? 0 : (maxX + 1) * pxMm,
      y1: count === 0 ? 0 : (maxY + 1) * pyMm,
    });

    files[`layer_images/layer_${i}.pw0Img`] = encodeLayerCropToMachineInternal(
      res.data,
      resX,
      resY,
      machine,
      { minX, minY, maxX, maxY, count }
    );

    if (opts.onProgress && (i % 50 === 0 || i === numLayers - 1)) {
      opts.onProgress(i + 1, numLayers);
    }
  }

  // preview — z náhledového slicu (pokud je), jinak placeholder
  let previews: Uint8Array[];
  if (opts.previewSlice && opts.makePreview) {
    const mid = Math.floor(opts.previewSlice.layers.length / 2);
    previews = await Promise.all([
      opts.makePreview(opts.previewSlice, 0, 224, 168),
      opts.makePreview(
        opts.previewSlice,
        Math.min(opts.previewSlice.layers.length - 1, Math.max(0, mid)),
        224,
        168
      ),
    ]);
  } else {
    // placeholder 1×1 PNG (dekódování base64 bez Buffer závislosti)
    const b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const bin = atob(b64);
    const ph = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) ph[i] = bin.charCodeAt(i);
    previews = [ph, ph];
  }

  let volumeMm3 = 0;
  for (const model of models) {
    let signed = 0;
    const p = model.positions;
    for (let t = 0; t < model.triangleCount; t++) {
      const o = t * 9;
      const cx = p[o + 4] * p[o + 8] - p[o + 5] * p[o + 7];
      const cy = p[o + 5] * p[o + 6] - p[o + 3] * p[o + 8];
      const cz = p[o + 3] * p[o + 7] - p[o + 4] * p[o + 6];
      signed += p[o] * cx + p[o + 1] * cy + p[o + 2] * cz;
    }
    volumeMm3 += Math.abs(signed) / 6;
  }
  const volumeMl = volumeMm3 / 1000;
  const printTimeS = opts.printTimeS ?? Math.round(numLayers * 10);

  files["anycubic_photon_resins.pwsp"] = new TextEncoder().encode(
    JSON.stringify(buildPwsp(machine), null, 4)
  );
  files["layers_controller.conf"] = new TextEncoder().encode(
    JSON.stringify(buildLayersControllerFrom(numLayers, settings.layerHeight, layerTimes, opts.bottomLayers ?? 5, {
      zupHeightBottom: opts.zupHeightBottom ?? 1.5,
      zupSpeedBottom: opts.zupSpeedBottom ?? 0.5,
      zupHeight: opts.zupHeight ?? 1.0,
      zupSpeed: opts.zupSpeed ?? 1.0,
    }), null, 4)
  );
  files["print_info.json"] = new TextEncoder().encode(
    JSON.stringify(buildPrintInfo(volumeMl, printTimeS))
  );
  files["software_info.conf"] = new TextEncoder().encode(
    JSON.stringify(
      { mark: "CHITUBOX", opengl: "3.3-CoreProfile", os: "win-64", version: "1.2.3" },
      null,
      4
    )
  );
  files["scene.slice"] = encodeSceneSlice(
    { layerCount: numLayers, bounds: union, layers: layerInfo },
    machine
  );
  files["preview_images/preview_0.png"] = previews[0];
  files["preview_images/preview_1.png"] = previews[1];

  const { zipSync, strToU8 } = await import("fflate");
  return {
    bytes: zipSync(files as unknown as Record<string, Uint8Array<ArrayBuffer>>),
    layers: numLayers,
  };
}
