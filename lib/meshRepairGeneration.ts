export interface MeshRepairRequestToken {
  requestId: number;
  modelId: number;
  revision: number;
}

export interface MeshRepairGeneration {
  next(modelId: number): MeshRepairRequestToken;
  invalidate(modelId: number): void;
  remove(modelId: number): void;
  clear(): void;
  isCurrent(token: MeshRepairRequestToken): boolean;
}

export function createMeshRepairGeneration(): MeshRepairGeneration {
  let requestId = 0;
  const currentByModel = new Map<number, MeshRepairRequestToken>();

  const advance = (modelId: number): MeshRepairRequestToken => {
    const previous = currentByModel.get(modelId);
    const token = {
      requestId: ++requestId,
      modelId,
      revision: (previous?.revision ?? 0) + 1,
    };
    currentByModel.set(modelId, token);
    return token;
  };

  return {
    next: advance,
    invalidate(modelId) {
      advance(modelId);
    },
    remove(modelId) {
      currentByModel.delete(modelId);
    },
    clear() {
      currentByModel.clear();
    },
    isCurrent(token) {
      const current = currentByModel.get(token.modelId);
      return current?.requestId === token.requestId && current.revision === token.revision;
    },
  };
}
