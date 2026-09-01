import assert from "node:assert/strict";
import { buildMeshRepairOverlay } from "../lib/meshRepairOverlay";
import { parseAsciiStl, type StlMesh } from "../lib/stl";
import type { MeshIssueSample } from "../lib/meshRepair";

function meshFromTriangle(): StlMesh {
  return parseAsciiStl(`solid test
facet normal 0 0 1
outer loop
vertex 1 2 3
vertex 4 2 3
vertex 1 5 3
endloop
endfacet
endsolid test`);
}

const mesh = meshFromTriangle();
const before = [...mesh.positions];
const triangleSample: MeshIssueSample = {
  kind: "degenerate-triangle",
  triangleIndices: [0],
};
const triangleOverlay = buildMeshRepairOverlay(mesh, triangleSample, { x: 10, y: -2 });
assert.ok(triangleOverlay.triangles);
assert.equal(triangleOverlay.edges, null);
assert.deepEqual(
  [...triangleOverlay.triangles!.getAttribute("position").array],
  [11, 0, 0, 14, 0, 0, 11, 3, 0],
);
assert.deepEqual([...mesh.positions], before, "overlay builder never mutates mesh positions");

const edgeSample: MeshIssueSample = {
  kind: "boundary-edge",
  triangleIndices: [0],
  edgeVertices: [0, 1],
  edgePoints: [[1, 2, 3], [4, 2, 3]],
};
const edgeOverlay = buildMeshRepairOverlay(mesh, edgeSample, { x: 10, y: -2 });
assert.equal(edgeOverlay.triangles, null);
assert.ok(edgeOverlay.edges);
assert.deepEqual(
  [...edgeOverlay.edges!.getAttribute("position").array],
  [11, 0, 0, 14, 0, 0],
);

assert.throws(
  () => buildMeshRepairOverlay(mesh, { kind: "duplicate-face", triangleIndices: [99] }, { x: 0, y: 0 }),
  /index/i,
);

triangleOverlay.triangles?.dispose();
edgeOverlay.edges?.dispose();
console.log("[OK] mesh repair overlays are exact, disposable, and immutable");
