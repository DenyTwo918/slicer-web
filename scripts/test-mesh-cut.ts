import assert from "node:assert/strict";
import { cutMeshByPlane } from "../lib/meshCut";
import { analyzeMesh } from "../lib/meshRepair";
import { parseAsciiStl, type StlMesh } from "../lib/stl";

type V3 = [number, number, number];
type Tri = [V3, V3, V3];

function meshFromTriangles(triangles: Tri[]): StlMesh {
  const body = triangles.map((triangle) =>
    `facet normal 0 0 0\nouter loop\n${triangle.map((v) => `vertex ${v.join(" ")}`).join("\n")}\nendloop\nendfacet`
  ).join("\n");
  return parseAsciiStl(`solid test\n${body}\nendsolid test`);
}

function cube(min: V3 = [0, 0, 0], max: V3 = [1, 1, 1]): Tri[] {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const p = (x: number, y: number, z: number): V3 => [x, y, z];
  return [
    [p(x0,y0,z0),p(x0,y1,z0),p(x1,y1,z0)],[p(x0,y0,z0),p(x1,y1,z0),p(x1,y0,z0)],
    [p(x0,y0,z1),p(x1,y1,z1),p(x0,y1,z1)],[p(x0,y0,z1),p(x1,y0,z1),p(x1,y1,z1)],
    [p(x0,y0,z0),p(x1,y0,z0),p(x1,y0,z1)],[p(x0,y0,z0),p(x1,y0,z1),p(x0,y0,z1)],
    [p(x0,y1,z0),p(x0,y1,z1),p(x1,y1,z1)],[p(x0,y1,z0),p(x1,y1,z1),p(x1,y1,z0)],
    [p(x0,y0,z0),p(x0,y0,z1),p(x0,y1,z1)],[p(x0,y0,z0),p(x0,y1,z1),p(x0,y1,z0)],
    [p(x1,y0,z0),p(x1,y1,z1),p(x1,y0,z1)],[p(x1,y0,z0),p(x1,y1,z0),p(x1,y1,z1)],
  ];
}

const source = meshFromTriangles(cube());
const before = [...source.positions];
const result = cutMeshByPlane(source, { normal: [1, 0, 0], constant: -0.5 }, { cap: false });
assert.deepEqual(result.negative.bounds.min, [0, 0, 0]);
assert.deepEqual(result.negative.bounds.max, [0.5, 1, 1]);
assert.deepEqual(result.positive.bounds.min, [0.5, 0, 0]);
assert.deepEqual(result.positive.bounds.max, [1, 1, 1]);
assert.ok(result.positive.triangleCount > 0 && result.negative.triangleCount > 0);
assert.ok(result.intersectionSegments > 0);
assert.deepEqual([...source.positions], before, "cut never mutates source geometry");
assert.ok(result.positive.positions.every(Number.isFinite));
assert.ok(result.negative.normals.every(Number.isFinite));

const capped = cutMeshByPlane(source, { normal: [1, 0, 0], constant: -0.5 });
for (const half of [capped.positive, capped.negative]) {
  const report = analyzeMesh(half);
  assert.equal(report.boundaryEdges.count, 0, "cap closes every cut boundary");
  assert.equal(report.degenerateTriangles.count, 0);
  assert.equal(report.inconsistentWinding.count, 0);
}
assert.ok(capped.capTriangles > 0);

assert.throws(
  () => cutMeshByPlane(source, { normal: [1, 0, 0], constant: -2 }, { cap: false }),
  /neprotíná/i,
);

console.log("[OK] exact planar cut clips both half-spaces without source mutation");
