import { runSlicePipeline, type PipelineModel, type PipelinePrinter, type PipelineSettings } from "./pipeline";
import type { SliceResult } from "./slice";

export interface SliceWorkerRequest {
  id: number;
  models: PipelineModel[];
  settings: PipelineSettings;
  printer: PipelinePrinter;
  forceCpu?: boolean;
}

export interface SliceWorkerResponse {
  id: number;
  ok: boolean;
  error?: string;
  result?: SliceResult | null;
  supportMask?: Uint8Array[] | null;
  engine?: "gpu" | "cpu";
}

/** Worker scope (typování bez konfliktu s dom lib) */
const ctx = self as unknown as {
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
  onmessage: ((ev: MessageEvent<SliceWorkerRequest>) => void) | null;
};

ctx.onmessage = async (ev: MessageEvent<SliceWorkerRequest>) => {
  const { id, models, settings, printer, forceCpu } = ev.data;
  try {
    const { result, supportMask, engine } = await runSlicePipeline(models, settings, printer, { forceCpu });
    // vrstvy a maska se přenesou bez kopie (transfer) — main thread je potřebuje,
    // worker po odeslání končí
    const transfer: Transferable[] = [];
    if (result) for (const l of result.layers) transfer.push(l.data.buffer);
    if (supportMask) for (const m of supportMask) transfer.push(m.buffer);
    const resp: SliceWorkerResponse = { id, ok: true, result, supportMask, engine };
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
