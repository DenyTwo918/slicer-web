import assert from "node:assert/strict";
import { analyzeMesh, limitMeshRepairReportSamples } from "../lib/meshRepair";
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

const valid = meshFromTriangles(tetra([0, 0, 0]));
const validBefore = [...valid.positions];
const validReport = analyzeMesh(valid);
assert.equal(validReport.shellCount, 1);
assert.equal(validReport.degenerateTriangles.count, 0);
assert.equal(validReport.duplicateFaces.count, 0);
assert.equal(validReport.boundaryEdges.count, 0);
assert.equal(validReport.nonManifoldEdges.count, 0);
assert.equal(validReport.inconsistentWinding.count, 0);
assert.equal(validReport.tinyShells.count, 0);
assert.equal(validReport.repairableCount, 0);
assert.deepEqual([...valid.positions], validBefore, "analysis never mutates input positions");

const openReport = analyzeMesh(meshFromTriangles(tetra([0, 0, 0]).slice(0, 3)));
assert.equal(openReport.boundaryEdges.count, 3);
assert.equal(openReport.nonManifoldEdges.count, 0);
assert.equal(openReport.boundaryEdges.samples[0].edgePoints?.length, 2);

const nonManifoldReport = analyzeMesh(meshFromTriangles([
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
  [[1, 0, 0], [0, 0, 0], [0, -1, 0]],
  [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
]));
assert.equal(nonManifoldReport.nonManifoldEdges.count, 1);

const degenerateReport = analyzeMesh(meshFromTriangles([
  ...tetra([0, 0, 0]),
  [[2, 0, 0], [2, 0, 0], [2, 1, 0]],
  [[3, 0, 0], [4, 0, 0], [5, 0, 0]],
]));
assert.equal(degenerateReport.degenerateTriangles.count, 2);
assert.deepEqual(degenerateReport.degenerateTriangles.samples.map((s) => s.triangleIndices), [[4], [5]]);

const a: V3 = [0, 0, 0];
const b: V3 = [1, 0, 0];
const c: V3 = [0, 1, 0];
const duplicateReport = analyzeMesh(meshFromTriangles([
  [a, b, c],
  [b, c, a],
  [c, b, a],
]));
assert.equal(duplicateReport.duplicateFaces.count, 2);
assert.deepEqual(duplicateReport.duplicateFaces.samples.map((s) => s.triangleIndices), [[1], [2]]);
assert.equal(duplicateReport.nonManifoldEdges.count, 0, "duplicate faces do not create false non-manifold findings");

const windingReport = analyzeMesh(meshFromTriangles([
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
]));
assert.equal(windingReport.inconsistentWinding.count, 1);
assert.deepEqual(windingReport.inconsistentWinding.samples[0].triangleIndices, [0, 1]);

const tinyShellReport = analyzeMesh(meshFromTriangles([
  ...tetra([0, 0, 0]),
  [[10, 0, 0], [10.01, 0, 0], [10, 0.01, 0]],
]));
assert.equal(tinyShellReport.shellCount, 2);
assert.equal(tinyShellReport.tinyShells.count, 1);
assert.deepEqual(tinyShellReport.tinyShells.samples[0].triangleIndices, [4]);

const deterministic = analyzeMesh(valid);
assert.deepEqual(deterministic, validReport);

const limited = limitMeshRepairReportSamples(openReport, 1);
assert.equal(limited.boundaryEdges.count, openReport.boundaryEdges.count);
assert.equal(limited.boundaryEdges.samples.length, 1);
assert.equal(openReport.boundaryEdges.samples.length, 3, "sample limiting does not mutate full report");

const bridgedEdges = meshFromTriangles([
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
  [[1.5e-5, 0, 0], [1 + 1.5e-5, 0, 0], [0, -1, 0]],
  [[0.75e-5, 0, 0], [3, 0, 0], [3, 1, 0]],
  [[1 + 0.75e-5, 0, 0], [4, 0, 0], [4, 1, 0]],
]);
const bridgedReport = analyzeMesh(bridgedEdges);
assert.equal(bridgedReport.shellCount, 4, "proximity bridges must not join disconnected shells");
assert.equal(bridgedReport.boundaryEdges.count, 12);
assert.equal(bridgedReport.inconsistentWinding.count, 0);

console.log("[OK] mesh diagnostics classify defects deterministically");
