import type { StlBounds } from "./stl";
import { sliceMesh, unionSlices, type SliceResult } from "./slice";
import { generateSupports, type SupportPreviewData } from "./supports";
import { applyHollow, carveDrainHolesInPlace, type DrainAnchor } from "./hollow";
import { applyRaft } from "./raft";
import { applyAA } from "./aa";
import { initNative } from "./native";
import { gpuSlice } from "./gpuSlice";
import { detectSupportAnchors } from "./supportDetect";
import { detectIslands, type IslandFinding } from "./islands";

/** Model pro pipeline — jen data, která slicing potřebuje (posílá se do workera). */
export interface PipelineModel {
  positions: Float32Array;
  bounds: StlBounds;
  triangleCount: number;
  /** pozice modelu na desce (mm) */
  tx: number;
  ty: number;
}

export interface PipelineSettings {
  layerHeight: number;
  hollow: boolean;
  wallMm: number;
  holeDiaMm: number;
  drainHoles: boolean;
  supports: boolean;
  supportRadiusMm: number;
  supportTipMm: number;
  /** max úhel podhledu od svislice (°) — podpírá se jen pod touto hodnotou */
  supportMaxAngleDeg?: number;
  /** rozestup kotev na desce (mm) */
  supportSpacingMm?: number;
  /** min výška kotvy nad deskou (mm) */
  supportClearanceMm?: number;
  raft: boolean;
  raftLayers: number;
  raftMarginMm: number;
  aa: boolean;
}

export interface PipelinePrinter {
  resX: number;
  resY: number;
  printX: number;
  printY: number;
}

export interface PipelineResult {
  result: SliceResult | null;
  /** Volitelná diagnostická maska; UI ji nevyžaduje a standardně se nealokuje. */
  supportMask: Uint8Array[] | null;
  /** Hladké 3D primitivy podpor; STL model se vždy vykresluje přímo z původního meshe. */
  supportPreview: SupportPreviewData | null;
  /** Který slicing engine běžel */
  engine: "gpu" | "cpu";
  diagnostics: SliceDiagnostics;
}

export interface SliceDiagnostics {
  /** Celkový počet zcela nových komponent bez opory v předchozí vrstvě. */
  islandCount: number;
  /** Omezený seznam pro navigaci v UI; celkový počet zůstává v islandCount. */
  islands: IslandFinding[];
  truncated: boolean;
  /** Kotvy automatických odvodňovacích otvorů v low-res rastru. */
  drainAnchors: DrainAnchor[];
}

/** Měřítko pro slicovací rastr — vždy dělí rozlišení tiskárny beze zbytku.
 *  1/16 = 16× méně pixelů než 1/1 (slice by jinak zabral ~550 MB a mohl spadnout). */
export function sliceScale(resX: number, resY: number): number {
  if (resX % 16 === 0 && resY % 16 === 0) return 16;
  if (resX % 8 === 0 && resY % 8 === 0) return 8;
  if (resX % 4 === 0 && resY % 4 === 0) return 4;
  if (resX % 2 === 0 && resY % 2 === 0) return 2;
  return 1;
}

/**
 * Celá slicovací pipeline (slice → hollow → podpory → raft → AA).
 * Čistá funkce — volá se z Web Workera (a jako fallback na hlavním vlákně).
 * Vrstvy a maska se vrací jako pole Uint8Array (transferable pro postMessage).
 */
export async function runSlicePipeline(
  models: PipelineModel[],
  settings: PipelineSettings,
  printer: PipelinePrinter,
  opts?: { forceCpu?: boolean; collectSupportMask?: boolean; preferGpu?: boolean }
): Promise<PipelineResult> {
  await initNative();
  if (models.length === 0) {
    return {
      result: null,
      supportMask: null,
      supportPreview: null,
      engine: "cpu",
      diagnostics: { islandCount: 0, islands: [], truncated: false, drainAnchors: [] },
    };
  }
  const scale = sliceScale(printer.resX, printer.resY);
  const sliceW = printer.resX / scale;
  const sliceH = printer.resY / scale;
  const mmPerPx = {
    x: printer.printX / sliceW,
    y: printer.printY / sliceH,
  };

  // GPU slicing (WebGPU depth-based; hollow už aplikované) — jinak CPU fallback
  let result: SliceResult | null = null;
  let collisionResult: SliceResult | null = null;
  let drainAnchors: DrainAnchor[] = [];
  let engine: "gpu" | "cpu" = "cpu";
  // Přesný vektorový CPU sweep je po Z-indexaci rychlý i na Benchy a na rozdíl
  // od depth mapy zachová více dutin/intervalů v jednom XY paprsku. GPU depth
  // zůstává jen jako explicitní experimentální volba.
  const gpu = opts?.preferGpu && !opts.forceCpu
    ? await gpuSlice({
        models,
        layerHeight: settings.layerHeight,
        hollow: settings.hollow,
        wallMm: settings.wallMm,
        drainHoles: settings.drainHoles,
        holeDiaMm: settings.holeDiaMm,
        printer,
      })
    : null;
  if (gpu) {
    result = gpu;
    if (!settings.hollow) collisionResult = gpu;
    engine = "gpu";
  } else {
    const globalZStart = Math.min(...models.map((m) => m.bounds.min[2]));
    const globalZEnd = Math.max(...models.map((m) => m.bounds.max[2]));
    for (const m of models) {
      const mesh = {
        positions: m.positions,
        bounds: m.bounds,
        triangleCount: m.triangleCount,
        normals: new Float32Array(0),
      };
      const s = sliceMesh(mesh, {
        layerHeight: settings.layerHeight,
        resolutionX: sliceW,
        resolutionY: sliceH,
        plateW: printer.printX,
        plateH: printer.printY,
        offsetX: m.tx,
        offsetY: m.ty,
        zStart: globalZStart,
        zEnd: globalZEnd,
      });
      result = result ? unionSlices(result, s) : s;
    }
    // Kolize podpor se vždy testují proti plnému vnějšímu objemu. Jinak by
    // u hollow modelu sloupy legálně vedly prázdnou dutinou uvnitř skořepiny.
    collisionResult = result;
    if (result && settings.hollow) {
      const hollowed = applyHollow(
        result,
        {
          enabled: true,
          wallMm: settings.wallMm,
          holeDiaMm: settings.holeDiaMm,
          drainHoles: settings.drainHoles,
        },
        mmPerPx,
        (anchors) => { drainAnchors = anchors; },
      );
      result = hollowed;
    }
  }
  let supportMask: Uint8Array[] | null = null;
  let supportPreview: SupportPreviewData | null = null;
  const px = Math.min(mmPerPx.x, mmPerPx.y);
  if (result && settings.supports) {
    // kotvy podpor z meshí (úhlová detekce) — podpírá se jen skutečný podhled
    let minZ = Infinity;
    for (const m of models) minZ = Math.min(minZ, m.bounds.min[2]);
    const anchors = detectSupportAnchors(models, {
      layerHeight: settings.layerHeight,
      minZ,
      resX: sliceW,
      resY: sliceH,
      printX: printer.printX,
      printY: printer.printY,
    }, {
      maxAngleDeg: settings.supportMaxAngleDeg,
      spacingMm: settings.supportSpacingMm,
      clearanceMm: settings.supportClearanceMm,
    });
    const sr = generateSupports(result, {
      enabled: true,
      radiusPx: Math.max(2, Math.round(settings.supportRadiusMm / px)),
      tipPx: Math.max(1, Math.round(settings.supportTipMm / px)),
      mmPerPx: mmPerPx.x,
      collectMask: opts?.collectSupportMask === true,
    }, anchors, collisionResult ?? result);
    result = sr.result;
    if (opts?.collectSupportMask) supportMask = sr.mask;
    supportPreview = sr.preview;
  }
  if (result && settings.raft) {
    const rr = applyRaft(
      result,
      { enabled: true, layers: settings.raftLayers, marginMm: settings.raftMarginMm },
      mmPerPx
    );
    result = rr.result;
    if (!supportPreview) {
      supportPreview = {
        resolutionX: result.resolutionX,
        resolutionY: result.resolutionY,
        layerHeight: result.layerHeight,
        radiusPx: 0,
        tipPx: 0,
        bottomRadiusPx: 0,
        braceRadiusPx: 0,
        pillars: [],
        braces: [],
      };
    }
    supportPreview.raftMask = rr.mask[0] ? new Uint8Array(rr.mask[0]) : null;
    supportPreview.raftLayers = Math.min(settings.raftLayers, result.layers.length);
    if (opts?.collectSupportMask) {
      if (!supportMask) {
        supportMask = rr.mask;
      } else {
        for (let i = 0; i < Math.min(supportMask.length, rr.mask.length); i++) {
          const a = supportMask[i];
          const b = rr.mask[i];
          if (a.length === 0 || b.length === 0) continue;
          for (let p = 0; p < a.length; p++) if (b[p]) a[p] = 1;
        }
      }
    }
  }
  // Supporty ani raft nesmí znovu uzavřít cestu dutina → exteriér.
  if (result && drainAnchors.length > 0) {
    carveDrainHolesInPlace(result, drainAnchors, settings.holeDiaMm, mmPerPx);
  }
  // Diagnostika musí vycházet z finální binární tiskové topologie.
  // AA ji následně jen převede na grayscale a mikroskopické ostrovy může rozmazat pod threshold.
  const allIslands = result ? detectIslands(result) : [];
  if (result && settings.aa) {
    result = applyAA(result);
  }
  const maxReportedIslands = 250;
  const diagnostics: SliceDiagnostics = {
    islandCount: allIslands.length,
    islands: allIslands.slice(0, maxReportedIslands),
    truncated: allIslands.length > maxReportedIslands,
    drainAnchors,
  };
  return { result, supportMask, supportPreview, engine, diagnostics };
}
