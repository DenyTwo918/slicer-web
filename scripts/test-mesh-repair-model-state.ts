import assert from "node:assert/strict";
import {
  applyRepairToModelState,
  duplicateRepairableModelState,
  restoreRepairBackup,
} from "../lib/meshRepairModelState";
import { parseAsciiStl } from "../lib/stl";
import type { MeshRepairResult } from "../lib/meshRepair";

const mesh = parseAsciiStl(`solid a
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid a`);
const repairedMesh = { ...mesh, positions: new Float32Array(mesh.positions) };
const transform = { x: 12, y: -4, rx: 10, ry: 20, rz: 30, scale: 1.5 };
const item = { id: 7, name: "test", mesh, transform };
const result: MeshRepairResult = {
  mesh: repairedMesh,
  sourceTriangleIndices: [0],
  removedDegenerate: 0,
  removedDuplicates: 0,
  flippedTriangles: 1,
  addedTriangles: 0,
  filledBoundaryLoops: 0,
};

const next = applyRepairToModelState(item, result);
assert.equal(next.mesh, repairedMesh);
assert.equal(next.transform, transform, "repair preserves active transform");
assert.equal(next.repairBackup?.mesh, mesh);
assert.deepEqual(next.repairBackup?.transform, transform);
assert.notEqual(next.repairBackup?.transform, transform, "backup transform is an immutable snapshot");

const restored = restoreRepairBackup(next);
assert.equal(restored.mesh, mesh);
assert.deepEqual(restored.transform, transform);
assert.equal(restored.repairBackup, undefined);

assert.equal(restoreRepairBackup(item), item, "no backup keeps existing reset path untouched");

const duplicated = duplicateRepairableModelState(next, { ...next.transform, x: 31, y: 32 });
assert.deepEqual(duplicated.transform, { ...next.transform, x: 31, y: 32 });
assert.equal(
  duplicated.repairBackup,
  undefined,
  "a repaired duplicate must not restore the source model's transform",
);

console.log("[OK] mesh repair state preserves transform and supports one-level restore");
