import assert from "node:assert/strict";
import { applyRaft } from "../lib/raft";
import type { SliceResult } from "../lib/slice";

const W = 21;
const H = 21;
const CX = 10;
const CY = 10;
const layerHeight = 1;
const layers = Array.from({ length: 10 }, (_, index) => {
  const data = new Uint8Array(W * H);
  data[CY * W + CX] = 1;
  return { index, z: (index + 0.5) * layerHeight, data };
});
const source: SliceResult = {
  layers,
  layerHeight,
  resolutionX: W,
  resolutionY: H,
  minX: 0,
  minY: 0,
};

const { result, mask } = applyRaft(source, {
  enabled: true,
  layers: 3,
  marginMm: 2,
  rimEnabled: true,
  rimWidthMm: 2,
  rimHeightMm: 3,
}, { x: 1, y: 1 });

const at = (layer: number, dx: number, dy = 0) =>
  result.layers[layer].data[(CY + dy) * W + CX + dx];
const inMask = (layer: number, dx: number, dy = 0) =>
  mask[layer][(CY + dy) * W + CX + dx];

// The solid floor supports the full base of the raised wall.
assert.equal(at(0, 4), 1, "bottom raft layer includes the outer spatula ledge");
assert.equal(at(2, 4), 1, "upper floor layer supports the complete rim base");

// Every 1 mm of rise moves both wall faces 1 mm outward: a true 45° wall.
assert.equal(at(3, 3), 1, "45-degree rim starts at its supported base");
assert.equal(inMask(3, 3), 1, "raised perimeter is recorded in the raft mask");
assert.equal(at(3, 2), 0, "tray interior is empty above the raft floor");
assert.equal(at(4, 3), 0, "inner wall face moves outward after 1 mm of rise");
assert.equal(at(4, 5), 1, "outer wall face moves outward after 1 mm of rise");
assert.equal(
  at(4, 5, 5),
  0,
  "convex corner uses a physical circular offset, not a sqrt(2)-too-wide box offset",
);
assert.equal(at(5, 4), 0, "inner wall face moves outward after 2 mm of rise");
assert.equal(at(5, 6), 1, "outer wall face moves outward after 2 mm of rise");
assert.equal(at(6, 5), 0, "rim stops after the requested height");

const legacy = applyRaft(source, {
  enabled: true,
  layers: 3,
  marginMm: 2,
}, { x: 1, y: 1 });
const explicitlyDisabled = applyRaft(source, {
  enabled: true,
  layers: 3,
  marginMm: 2,
  rimEnabled: false,
  rimWidthMm: 2,
  rimHeightMm: 3,
}, { x: 1, y: 1 });
assert.deepEqual(
  explicitlyDisabled.result.layers.map((layer) => layer.data),
  legacy.result.layers.map((layer) => layer.data),
  "disabled rim preserves the legacy flat raft exactly",
);

const thinRim = applyRaft(source, {
  enabled: true,
  layers: 3,
  marginMm: 2,
  rimEnabled: true,
  rimWidthMm: 0.5,
  rimHeightMm: 2,
}, { x: 1, y: 1 });
let adjacentOverlap = 0;
let axisOverlap = 0;
for (let p = 0; p < W * H; p++) {
  if (thinRim.mask[3][p] && thinRim.mask[4][p]) {
    adjacentOverlap++;
    if (((p / W) | 0) === CY) axisOverlap++;
  }
}
assert.ok(
  adjacentOverlap > 0,
  "validated 45-degree rim width must keep every raised layer connected to the previous one",
);
assert.ok(
  axisOverlap > 0,
  "thin settings must not leave straight wall sections supported only by isolated corner pixels",
);

const coarseSource: SliceResult = {
  ...source,
  layerHeight: 0.1,
  layers: source.layers.map((layer, index) => ({
    ...layer,
    z: (index + 0.5) * 0.1,
    data: new Uint8Array(layer.data),
  })),
};
const coarseThinRim = applyRaft(coarseSource, {
  enabled: true,
  layers: 3,
  marginMm: 2,
  rimEnabled: true,
  rimWidthMm: 0.05,
  rimHeightMm: 0.7,
}, { x: 0.5, y: 0.5 });
let coarseAxisOverlap = 0;
for (let x = 0; x < W; x++) {
  const p = CY * W + x;
  if (coarseThinRim.mask[7][p] && coarseThinRim.mask[8][p]) coarseAxisOverlap++;
}
assert.ok(
  coarseAxisOverlap > 0,
  "pixel-quantized 45-degree wall must retain straight-edge overlap at coarse pitch",
);

console.log("[OK] raft rim forms a printable 45-degree outward tray wall");
