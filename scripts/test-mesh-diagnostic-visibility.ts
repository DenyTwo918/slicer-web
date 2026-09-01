import assert from "node:assert/strict";
import { shouldShowMeshDiagnosticOverlay } from "../lib/meshDiagnosticVisibility";

assert.equal(
  shouldShowMeshDiagnosticOverlay({ modelId: 7, diagnosticModelId: 7, layerPreviewActive: false }),
  true,
);
assert.equal(
  shouldShowMeshDiagnosticOverlay({ modelId: 7, diagnosticModelId: 7, layerPreviewActive: true }),
  true,
  "an active slice preview must not hide a selected red mesh diagnostic",
);
assert.equal(
  shouldShowMeshDiagnosticOverlay({ modelId: 8, diagnosticModelId: 7, layerPreviewActive: true }),
  false,
);

console.log("[OK] selected mesh diagnostics stay visible during slice preview");
