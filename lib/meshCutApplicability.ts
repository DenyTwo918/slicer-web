/** A worker result may only replace the exact immutable model revision it started from. */
export function isMeshCutResponseApplicable<T extends object>(currentModel:T|undefined,pendingModel:T):boolean{
  return currentModel===pendingModel;
}
