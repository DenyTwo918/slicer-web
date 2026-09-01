export interface MeshDiagnosticVisibilityInput {
  modelId: number;
  diagnosticModelId: number | null;
  layerPreviewActive: boolean;
}

export function shouldShowMeshDiagnosticOverlay({
  modelId,
  diagnosticModelId,
}: MeshDiagnosticVisibilityInput): boolean {
  // Slice preview and diagnostic overlay are independent views of the same model.
  return diagnosticModelId !== null && diagnosticModelId === modelId;
}
