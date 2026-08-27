import { runSlicePipeline, type PipelineModel, type PipelinePrinter, type PipelineSettings } from "./pipeline";
import type { SliceResult } from "./slice";
import { buildPm7FullRes } from "./fullRes";
import type { PrinterProfile } from "./profiles";
import type { SupportPreviewData } from "./supports";

export interface SliceWorkerRequest {
  id: number;
  kind?: "slice" | "exportFull";
  models: PipelineModel[];
  settings: PipelineSettings;
  printer: PrinterProfile;
  forceCpu?: boolean;
  /** pro kind=exportFull */
  exposures?: {
    bottomExposure: number;
    normalExposure: number;
    bottomLayers: number;
    zupHeightBottom: number;
    zupSpeedBottom: number;
    zupHeight: number;
    zupSpeed: number;
    printTimeS: number;
  };
  /** náhledy vygenerované na hlavním vlákně (canvas) */
  previews?: [Uint8Array, Uint8Array] | null;
}

export interface SliceWorkerResponse {
  id: number;
  ok: boolean;
  kind?: "slice" | "exportFull" | "exportFull-progress";
  error?: string;
  result?: SliceResult | null;
  supportPreview?: SupportPreviewData | null;
  engine?: "gpu" | "cpu";
  bytes?: Uint8Array;
  done?: number;
  total?: number;
}

/** Worker scope (typování bez konfliktu s dom lib) */
const ctx = self as unknown as {
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
  onmessage: ((ev: MessageEvent<SliceWorkerRequest>) => void) | null;
};

ctx.onmessage = async (ev: MessageEvent<SliceWorkerRequest>) => {
  const { id, kind } = ev.data;

  // full-res streaming export
  if (kind === "exportFull") {
    const { models, settings, printer, exposures, previews } = ev.data;
    try {
      const res = await buildPm7FullRes(
        models,
        settings,
        printer,
        models,
        {
          ...(exposures ?? {}),
          previewSlice: null,
          previews: previews ?? null,
          onProgress: (done, total) => {
            ctx.postMessage({ id, ok: true, kind: "exportFull-progress", done, total });
          },
        }
      );
      const bytes = res.bytes;
      ctx.postMessage({ id, ok: true, kind: "exportFull", bytes }, [bytes.buffer]);
    } catch (err) {
      ctx.postMessage({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  const { models, settings, printer, forceCpu } = ev.data;
  try {
    const { result, supportPreview, engine } = await runSlicePipeline(
      models,
      settings,
      printer,
      { forceCpu }
    );
    // Vrstvy se přenesou bez kopie (transfer); worker zůstává připravený
    // pro další požadavek.
    const transfer: Transferable[] = [];
    if (result) for (const l of result.layers) transfer.push(l.data.buffer);
    if (supportPreview?.raftMask) transfer.push(supportPreview.raftMask.buffer);
    const resp: SliceWorkerResponse = {
      id,
      ok: true,
      result,
      supportPreview,
      engine,
    };
    ctx.postMessage(resp, transfer);
  } catch (err) {
    const resp: SliceWorkerResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(resp);
  }
};
