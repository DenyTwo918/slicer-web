import assert from "node:assert/strict";
import {
  analyzeMesh,
  analyzeMeshForSafeRepair,
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

// Regression: a closed, unbranched boundary loop left by one missing tetrahedron
// face must be capped. Removing boundary-loop filling should make these literal
// topology and triangle-count expectations fail.
const tetraWithMissingFace = meshFromTriangles(base.slice(0, 3));
const missingFaceAnalysis = analyzeMeshForSafeRepair(tetraWithMissingFace);
assert.equal(missingFaceAnalysis.report.boundaryEdges.count, 3);
assert.equal(missingFaceAnalysis.plan.fillBoundaryTriangles.length, 1);
const closedTetra = applySafeMeshRepair(tetraWithMissingFace, missingFaceAnalysis.plan);
assert.equal(closedTetra.addedTriangles, 1);
assert.equal(closedTetra.filledBoundaryLoops, 1);
assert.equal(closedTetra.mesh.triangleCount, 4);
assert.equal(analyzeMesh(closedTetra.mesh).boundaryEdges.count, 0);
assert.equal(
  analyzeMeshForSafeRepair(closedTetra.mesh).plan.fillBoundaryTriangles.length,
  0,
  "a closed patch is idempotent and must not be filled again",
);

// A lone open sheet is ambiguous, not a safely repairable solid shell. It must
// remain untouched instead of being doubled into two coincident faces.
const openSheet = meshFromTriangles([base[0]]);
const openSheetPlan = analyzeMeshForSafeRepair(openSheet).plan;
assert.deepEqual(openSheetPlan.fillBoundaryTriangles, []);
assert.equal(applySafeMeshRepair(openSheet, openSheetPlan).mesh.triangleCount, 1);

// A non-planar four-edge boundary is ambiguous: a flat cap would alter the
// source shape, so the safe plan must leave it highlighted and unresolved.
const nonPlanarBoundary = meshFromTriangles([
  [[0, 0, 0], [1, 0, 0], [0.5, 0.5, 1]],
  [[1, 0, 0], [1, 1, 0.2], [0.5, 0.5, 1]],
  [[1, 1, 0.2], [0, 1, 0], [0.5, 0.5, 1]],
  [[0, 1, 0], [0, 0, 0], [0.5, 0.5, 1]],
]);
const nonPlanarPlan = analyzeMeshForSafeRepair(nonPlanarBoundary).plan;
assert.deepEqual(nonPlanarPlan.fillBoundaryTriangles, []);
assert.equal(analyzeMesh(applySafeMeshRepair(nonPlanarBoundary, nonPlanarPlan).mesh).boundaryEdges.count, 4);

// Concave planar holes need contour triangulation, not a centroid fan that can
// spill outside the L-shaped opening.
const bottom: V3[] = [[0, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0], [1, 2, 0], [0, 2, 0]];
const top = bottom.map(([x, y]) => [x, y, 1] as V3);
const concaveOpenPrism: Tri[] = [
  [bottom[0], bottom[3], bottom[1]],
  [bottom[1], bottom[3], bottom[2]],
  [bottom[0], bottom[5], bottom[3]],
  [bottom[3], bottom[5], bottom[4]],
];
for (let index = 0; index < bottom.length; index++) {
  const next = (index + 1) % bottom.length;
  concaveOpenPrism.push(
    [bottom[index], bottom[next], top[next]],
    [bottom[index], top[next], top[index]],
  );
}
const concaveMesh = meshFromTriangles(concaveOpenPrism);
const concavePlan = analyzeMeshForSafeRepair(concaveMesh).plan;
assert.equal(concavePlan.fillBoundaryTriangles.length, 4);
const closedConcaveMesh = applySafeMeshRepair(concaveMesh, concavePlan).mesh;
const closedConcaveReport = analyzeMesh(closedConcaveMesh);
assert.equal(closedConcaveReport.boundaryEdges.count, 0);
assert.equal(closedConcaveReport.inconsistentWinding.count, 0);

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

const bridgeWeld = meshFromTriangles([
  [[0, 0, 0], [1.5e-5, 0, 0], [0, 1, 0]],
  [[0.75e-5, 0, 0], [2, 0, 0], [2, 1, 0]],
]);
const bridgePlan = planSafeMeshRepair(bridgeWeld, analyzeMesh(bridgeWeld));
assert.deepEqual(
  bridgePlan.removeDegenerateTriangles,
  [],
  "transitive proximity welding must not make a nonzero-area source face removable",
);
assert.equal(applySafeMeshRepair(bridgeWeld, bridgePlan).mesh.triangleCount, 2);

const manyDegenerates = meshFromTriangles(Array.from({ length: 250 }, (_, index) => [
  [index, 0, 0],
  [index, 0, 0],
  [index, 1, 0],
] as Tri));
const boundedAnalysis = analyzeMeshForSafeRepair(manyDegenerates, { maxSamplesPerKind: 3 });
assert.equal(boundedAnalysis.report.degenerateTriangles.samples.length, 3);
assert.equal(boundedAnalysis.plan.removeDegenerateTriangles.length, 250);

console.log("[OK] safe mesh repair preserves intended geometry");
