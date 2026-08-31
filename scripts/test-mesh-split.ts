import assert from "node:assert/strict";
import { extractMeshTriangles, splitConnectedShells } from "../lib/meshSplit";
import { parseAsciiStl, type StlMesh } from "../lib/stl";

type V3 = [number, number, number];
type Tri = [V3, V3, V3];

function meshFromTriangles(triangles: Tri[]): StlMesh {
  const body = triangles.map((triangle) =>
    `facet normal 0 0 0\nouter loop\n${triangle.map((v) => `vertex ${v.join(" ")}`).join("\n")}\nendloop\nendfacet`
  ).join("\n");
  return parseAsciiStl(`solid test\n${body}\nendsolid test`);
}

const tetra = (origin: V3, direction = 1): Tri[] => {
  const [x, y, z] = origin;
  const a: V3 = [x, y, z];
  const b: V3 = [x + direction, y, z];
  const c: V3 = [x, y + direction, z];
  const d: V3 = [x, y, z + direction];
  return [
    [a, c, b],
    [a, b, d],
    [a, d, c],
    [b, c, d],
  ];
};

const one = meshFromTriangles(tetra([0, 0, 0]));
const oneShell = splitConnectedShells(one);
assert.equal(oneShell.length, 1, "one connected tetrahedron remains one model");
assert.equal(oneShell[0].mesh.triangleCount, 4);
assert.deepEqual([...oneShell[0].mesh.positions], [...one.positions], "single shell preserves triangle order and coordinates");

const separated = meshFromTriangles([
  ...tetra([0, 0, 0]),
  ...tetra([10, 0, 0]),
]);
const separatedShells = splitConnectedShells(separated);
assert.equal(separatedShells.length, 2, "separated closed shells become two models");
assert.deepEqual(separatedShells.map((shell) => shell.mesh.triangleCount), [4, 4]);
assert.deepEqual(separatedShells.map((shell) => shell.triangleIndices), [[0, 1, 2, 3], [4, 5, 6, 7]]);
assert.equal(
  separatedShells.reduce((sum, shell) => sum + shell.mesh.triangleCount, 0),
  separated.triangleCount,
  "split neither loses nor duplicates triangles",
);

const pointTouching = meshFromTriangles([
  ...tetra([0, 0, 0]),
  ...tetra([0, 0, 0], -1),
]);
assert.equal(
  splitConnectedShells(pointTouching).length,
  2,
  "shells touching only at one vertex remain separate",
);

const almostSharedEdge = meshFromTriangles([
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
  [[1 + 1e-7, 0, 0], [0, 0 + 1e-7, 0], [1, 1, 0]],
]);
assert.equal(
  splitConnectedShells(almostSharedEdge).length,
  1,
  "STL float noise within welding tolerance keeps a shared edge connected",
);

const toleranceBoundaryEdge = meshFromTriangles([
  [[0.49e-5, 0, 0], [1 + 0.49e-5, 0, 0], [0, 1, 0]],
  [[0.51e-5, 0, 0], [1 + 0.51e-5, 0, 0], [1, 1, 0]],
]);
assert.equal(
  splitConnectedShells(toleranceBoundaryEdge).length,
  1,
  "vertices within tolerance weld even when they fall on opposite quantization cells",
);

const transformedOriginal = meshFromTriangles([
  ...tetra([100, 0, 0]),
  ...tetra([110, 0, 0]),
]);
const restoredPart = extractMeshTriangles(transformedOriginal, separatedShells[1].triangleIndices);
assert.equal(restoredPart.triangleCount, 4, "triangle indices can rebuild the matching original shell for Reset");
assert.deepEqual(restoredPart.bounds.min, [110, 0, 0]);
assert.deepEqual(restoredPart.bounds.max, [111, 1, 1]);

for (const shell of separatedShells) {
  assert.ok(shell.mesh.normals.every(Number.isFinite), "split part has finite recalculated normals");
  assert.ok(shell.mesh.bounds.min.every(Number.isFinite), "split part has finite bounds");
}

console.log("[OK] connected-shell split is deterministic and geometry-preserving");
