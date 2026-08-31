import assert from "node:assert/strict";
import { buildMeshTopology } from "../lib/meshTopology";
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
  return [[a, c, b], [a, b, d], [a, d, c], [b, c, d]];
};

const closed = buildMeshTopology(meshFromTriangles(tetra([0, 0, 0])));
assert.deepEqual(closed.shells, [[0, 1, 2, 3]]);
assert.equal(closed.edges.length, 6);
assert.ok(closed.edges.every((edge) => edge.uses.length === 2));
assert.deepEqual(closed.triangleNeighbors, [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]]);

const separated = buildMeshTopology(meshFromTriangles([
  ...tetra([0, 0, 0]),
  ...tetra([10, 0, 0]),
]));
assert.deepEqual(separated.shells, [[0, 1, 2, 3], [4, 5, 6, 7]]);

const pointTouching = buildMeshTopology(meshFromTriangles([
  ...tetra([0, 0, 0]),
  ...tetra([0, 0, 0], -1),
]));
assert.equal(pointTouching.shells.length, 2, "point contact does not create triangle adjacency");

const boundary = buildMeshTopology(meshFromTriangles(tetra([0, 0, 0]).slice(0, 3)));
assert.equal(boundary.edges.filter((edge) => edge.uses.length === 1).length, 3);

const nonManifold = buildMeshTopology(meshFromTriangles([
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
  [[1, 0, 0], [0, 0, 0], [0, -1, 0]],
  [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
]));
assert.equal(nonManifold.edges.filter((edge) => edge.uses.length === 3).length, 1);

const toleranceBoundary = buildMeshTopology(meshFromTriangles([
  [[0.49e-5, 0, 0], [1 + 0.49e-5, 0, 0], [0, 1, 0]],
  [[0.51e-5, 0, 0], [1 + 0.51e-5, 0, 0], [1, 1, 0]],
]));
assert.deepEqual(toleranceBoundary.shells, [[0, 1]]);
assert.equal(toleranceBoundary.edges.filter((edge) => edge.uses.length === 2).length, 1);

const repeat = buildMeshTopology(meshFromTriangles(tetra([0, 0, 0])));
assert.deepEqual(repeat.shells, closed.shells);
assert.deepEqual(repeat.edges, closed.edges);
assert.deepEqual([...repeat.weldedVertexByOccurrence], [...closed.weldedVertexByOccurrence]);

console.log("[OK] mesh topology is deterministic and tolerance-safe");
