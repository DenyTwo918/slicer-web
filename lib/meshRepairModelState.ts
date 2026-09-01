import type { MeshRepairResult } from "./meshRepair";
import type { StlMesh } from "./stl";

export interface RepairableModel<TTransform extends object> {
  mesh: StlMesh;
  transform: TTransform;
  repairBackup?: { mesh: StlMesh; transform: TTransform };
}

export function applyRepairToModelState<
  TTransform extends object,
  TModel extends RepairableModel<TTransform>,
>(
  item: TModel,
  result: MeshRepairResult,
): TModel & { repairBackup: { mesh: StlMesh; transform: TTransform } } {
  return {
    ...item,
    mesh: result.mesh,
    transform: item.transform,
    repairBackup: {
      mesh: item.mesh,
      transform: { ...item.transform },
    },
  };
}

export function restoreRepairBackup<
  TTransform extends object,
  TModel extends RepairableModel<TTransform>,
>(item: TModel): TModel {
  if (!item.repairBackup) return item;
  return {
    ...item,
    mesh: item.repairBackup.mesh,
    transform: { ...item.repairBackup.transform },
    repairBackup: undefined,
  };
}

export function duplicateRepairableModelState<
  TModel extends RepairableModel<object>,
>(item: TModel, transform: TModel["transform"]): TModel {
  return {
    ...item,
    transform,
    // A duplicate is independent; restoring the source backup would move it onto the source.
    repairBackup: undefined,
  };
}
