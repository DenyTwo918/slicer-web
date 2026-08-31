import assert from "node:assert/strict";
import {
  analyzeMesh,
  applySafeMeshRepair,
  planSafeMeshRepair,
} from "../lib/meshRepair";
import { parseAsciiStl, type StlMesh } from "../lib/stl";

type V3 = [number, number, number];
type Tri = [V3, V3, V3];

function meshFromTriangles(triangles: Tri[]): StlMesh {
  const body = triangles.map((triangle) =>
    `facet normal 0 0 0\nouter loop\n${triangle.map((v) => `vertex ${v.join(" ")}`).join("\n")}\nendloop\nendfacet`
  ).join("\n");
  return parseAsciiStl(`solid test\n${body}\nendsolid test`);
}

const tetra = (origin: V3): Tri[] => {
  const [x, y, z] = origin;
  const a: V3 = [x, y, z];
  const b: V3 = [x + 1, y, z];
  const c: V3 = [x, y + 1, z];
  const d: V3 = [x, y, z + 1];
  return [[a, c, b], [a, b, d], [a, d, c], [b, c, d]];
};

const base = tetra([0, 0, 0]);
const broken = meshFromTriangles([
  ...base,
  [[2, 0, 0], [2, 0, 0], [2, 1, 0]],
  base[0],
]);
const before = [...broken.positions];
const plan = planSafeMeshRepair(broken, analyzeMesh(broken));
assert.deepEqual(plan.removeDegenerateTriangles, [4]);
assert.deepEqual(plan.removeDuplicateTriangles, [5]);
const repaired = applySafeMeshRepair(broken, plan);
assert.equal(repaired.mesh.triangleCount, 4);
assert.deepEqual(repaired.sourceTriangleIndices, [0, 1, 2, 3]);
assert.equal(repaired.removedDegenerate, 1);
assert.equal(repaired.removedDuplicates, 1);
assert.equal(analyzeMesh(repaired.mesh).repairableCount, 0);
assert.deepEqual([...broken.positions], before, "repair never mutates source positions");

const winding = meshFromTriangles([
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
]);
const windingPlan = planSafeMeshRepair(winding, analyzeMesh(winding));
assert.equal(windingPlan.flipTriangles.length, 1);
const windingResult = applySafeMeshRepair(winding, windingPlan);
assert.equal(windingResult.flippedTriangles, 1);
assert.equal(analyzeMesh(windingResult.mesh).inconsistentWinding.count, 0);
assert.deepEqual(
  [...windingResult.mesh.positions].sort((a, b) => a - b),
  [...winding.positions].sort((a, b) => a - b),
  "winding repair only changes vertex order",
);

const withTinyShell = meshFromTriangles([
  ...base,
  [[10, 0, 0], [10.01, 0, 0], [10, 0.01, 0]],
]);
const tinyResult = applySafeMeshRepair(withTinyShell, planSafeMeshRepair(withTinyShell, analyzeMesh(withTinyShell)));
assert.equal(tinyResult.mesh.triangleCount, 5, "safe repair preserves tiny shells");

const nonManifold = meshFromTriangles([
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
  [[1, 0, 0], [0, 0, 0], [0, -1, 0]],
  [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
]);
const nonManifoldResult = applySafeMeshRepair(nonManifold, planSafeMeshRepair(nonManifold, analyzeMesh(nonManifold)));
assert.equal(nonManifoldResult.mesh.triangleCount, 3);
assert.equal(analyzeMesh(nonManifoldResult.mesh).nonManifoldEdges.count, 1);

const repeat = applySafeMeshRepair(broken, planSafeMeshRepair(broken, analyzeMesh(broken)));
assert.deepEqual([...repeat.mesh.positions], [...repaired.mesh.positions]);
assert.deepEqual([...repeat.mesh.normals], [...repaired.mesh.normals]);
assert.ok(repaired.mesh.normals.every(Number.isFinite));
assert.ok(repaired.mesh.bounds.min.every(Number.isFinite));

const allDegenerate = meshFromTriangles([[[0, 0, 0], [0, 0, 0], [0, 0, 0]]]);
assert.throws(
  () => applySafeMeshRepair(allDegenerate, planSafeMeshRepair(allDegenerate, analyzeMesh(allDegenerate))),
  /prázdný model/i,
);

console.log("[OK] safe mesh repair preserves intended geometry");
