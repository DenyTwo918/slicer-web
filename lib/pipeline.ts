import type { StlBounds } from "./stl";
import { sliceMesh, unionSlices, type SliceResult } from "./slice";
import { generateSupports, type SupportPreviewData } from "./supports";
import { applyHollow } from "./hollow";
import { applyRaft } from "./raft";
import { applyAA } from "./aa";
import { initNative } from "./native";
import { gpuSlice } from "./gpuSlice";
import { detectSupportAnchors } from "./supportDetect";

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
  supportMask: Uint8Array[] | null;
  /** Hladké 3D primitivy podpor; STL model se vždy vykresluje přímo z původního meshe. */
  supportPreview: SupportPreviewData | null;
  /** Který slicing engine běžel */
  engine: "gpu" | "cpu";
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
  opts?: { forceCpu?: boolean }
): Promise<PipelineResult> {
  await initNative();
  if (models.length === 0) {
    return { result: null, supportMask: null, supportPreview: null, engine: "cpu" };
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
  let engine: "gpu" | "cpu" = "cpu";
  const gpu = !opts?.forceCpu
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
    engine = "gpu";
  } else {
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
      });
      result = result ? unionSlices(result, s) : s;
    }
    if (result && settings.hollow) {
      result = applyHollow(
        result,
        {
          enabled: true,
          wallMm: settings.wallMm,
          holeDiaMm: settings.holeDiaMm,
          drainHoles: settings.drainHoles,
        },
        mmPerPx
      );
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
    }, anchors);
    result = sr.result;
    supportMask = sr.mask;
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
    // Vlastní buffer: worker současně transferuje supportMask a stejný ArrayBuffer
    // nesmí být v transfer listu dvakrát.
    supportPreview.raftMask = rr.mask[0] ? new Uint8Array(rr.mask[0]) : null;
    supportPreview.raftLayers = Math.min(settings.raftLayers, result.layers.length);
    if (supportMask) {
      const n = Math.min(supportMask.length, rr.mask.length);
      for (let i = 0; i < n; i++) {
        const a = supportMask[i];
        const b = rr.mask[i];
        for (let p = 0; p < a.length; p++) {
          if (b[p]) a[p] = 1;
        }
      }
    } else {
      supportMask = rr.mask;
    }
  }
  if (result && settings.aa) {
    result = applyAA(result);
  }
  return { result, supportMask, supportPreview, engine };
}
