import { strict as assert } from "node:assert";
import { md5Hex } from "../lib/anycubic";
import { applyHollow } from "../lib/hollow";
import { parseObj } from "../lib/obj";
import { meshStats } from "../lib/orient";
import { buildLayersControllerFrom, encodeRlePw0 } from "../lib/pm7";
import { sliceMesh, unionSlices, type SliceResult } from "../lib/slice";
import type { StlMesh } from "../lib/stl";
import { mirrorMesh, totalVolume } from "../lib/transform";

function tetra(reverse = false): StlMesh {
  const v = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
  if (reverse) faces = faces.map(([a, b, c]) => [a, c, b]);
  const positions = new Float32Array(faces.flatMap((f) => f.flatMap((i) => v[i])));
  return {
    positions,
    normals: new Float32Array(positions.length),
    triangleCount: faces.length,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}

assert.ok(Math.abs(totalVolume([tetra()]) - 1 / 6) < 1e-8, "objem tetraedru");
for (const m of [tetra(), tetra(true)]) {
  const s = meshStats(m);
  assert.ok(Math.abs(s.volume - 1 / 6) < 1e-8, "objem nezávislý na windingu");
  assert.deepEqual(s.com.map((x) => +x.toFixed(6)), [0.25, 0.25, 0.25]);
}

const obj = parseObj("v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n");
assert.deepEqual(Array.from(obj.positions.slice(0, 9)), [0, 0, 0, 1, 0, 0, 0, 1, 0]);

const mirrored = mirrorMesh(tetra(), "x");
const p = mirrored.positions;
const e1 = [p[3] - p[0], p[4] - p[1], p[5] - p[2]];
const e2 = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
assert.ok(cross[0] * mirrored.normals[0] + cross[1] * mirrored.normals[1] + cross[2] * mirrored.normals[2] >= 0);
assert.ok(Math.abs(totalVolume([mirrored]) - 1 / 6) < 1e-8);

const partial = sliceMesh(tetra(), { layerHeight: 0.3, resolutionX: 16, resolutionY: 16 });
assert.equal(partial.layers.length, 4, "částečná horní vrstva se nesmí zahodit");
assert.ok(partial.layers[3].z < 1);
assert.throws(() => unionSlices(partial, { ...partial, resolutionX: 8 }));

const layers = Array.from({ length: 10 }, (_, index) => {
  const data = new Uint8Array(25).fill(1);
  return { index, z: (index + 0.5) * 0.1, data };
});
const solid: SliceResult = { layers, layerHeight: 0.1, resolutionX: 5, resolutionY: 5, minX: 0, minY: 0 };
const hollow = applyHollow(solid, { enabled: true, wallMm: 0.2, holeDiaMm: 1, drainHoles: false }, { x: 0.1, y: 0.1 });
assert.equal(hollow.layers[5].data[12], 0, "střed dutiny");
assert.equal(hollow.layers[9].data[12], 1, "horní Z stěna");

assert.equal(md5Hex(""), "D41D8CD98F00B204E9800998ECF8427E");
assert.equal(md5Hex("abc"), "900150983CD24FB0D6963F7D28E17F72");
assert.deepEqual(Array.from(encodeRlePw0(new Uint8Array([0, 1, 255, 128]))), [0, 1, 0xf0, 2, 0x81]);

const ctrl = buildLayersControllerFrom(8, 0.05, new Array(8).fill(2), 3, {
  zupHeightBottom: 2, zupSpeedBottom: 0.5, zupHeight: 1, zupSpeed: 1,
});
assert.deepEqual(ctrl.paras.map((x) => x.zup_height), [2, 2, 2, 1, 1, 1, 1, 1]);

console.log("PASS regressions");
