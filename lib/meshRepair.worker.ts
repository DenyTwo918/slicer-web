import {
  analyzeMeshForSafeRepair,
  type MeshRepairPlan,
  type MeshRepairReport,
} from "./meshRepair";
import type { StlMesh } from "./stl";

export interface MeshRepairWorkerRequest {
  requestId: number;
  modelId: number;
  revision: number;
  mesh: StlMesh;
}

export interface MeshRepairWorkerResponse {
  requestId: number;
  modelId: number;
  revision: number;
  ok: boolean;
  report?: MeshRepairReport;
  plan?: MeshRepairPlan;
  error?: string;
}

const ctx = self as unknown as {
  postMessage: (message: MeshRepairWorkerResponse) => void;
  onmessage: ((event: MessageEvent<MeshRepairWorkerRequest>) => void) | null;
};

ctx.onmessage = (event) => {
  const { requestId, modelId, revision, mesh } = event.data;
  try {
    const { report, plan } = analyzeMeshForSafeRepair(mesh, { maxSamplesPerKind: 100 });
    ctx.postMessage({
      requestId,
      modelId,
      revision,
      ok: true,
      report,
      plan,
    });
  } catch (error) {
    ctx.postMessage({
      requestId,
      modelId,
      revision,
      ok: false,
      error: error instanceof Error ? error.message : "Analýza modelu selhala.",
    });
  }
};
