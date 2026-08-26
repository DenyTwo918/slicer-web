import { runSlicePipeline, type PipelineModel, type PipelinePrinter, type PipelineSettings } from "./pipeline";
import type { SliceResult } from "./slice";

export interface SliceWorkerRequest {
  id: number;
  models: PipelineModel[];
  settings: PipelineSettings;
  printer: PipelinePrinter;
}

export interface SliceWorkerResponse {
  id: number;
  ok: boolean;
  error?: string;
  result?: SliceResult | null;
  supportMask?: Uint8Array[] | null;
}

/** Worker scope (typování bez konfliktu s dom lib) */
const ctx = self as unknown as {
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
  onmessage: ((ev: MessageEvent<SliceWorkerRequest>) => void) | null;
};

ctx.onmessage = (ev: MessageEvent<SliceWorkerRequest>) => {
  const { id, models, settings, printer } = ev.data;
  try {
    const { result, supportMask } = runSlicePipeline(models, settings, printer);
    // vrstvy a maska se přenesou bez kopie (transfer) — main thread je potřebuje,
    // worker po odeslání končí
    const transfer: Transferable[] = [];
    if (result) for (const l of result.layers) transfer.push(l.data.buffer);
    if (supportMask) for (const m of supportMask) transfer.push(m.buffer);
    const resp: SliceWorkerResponse = { id, ok: true, result, supportMask };
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
