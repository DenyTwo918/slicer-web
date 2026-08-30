import assert from "node:assert/strict";
import { applyRaft } from "../lib/raft";
import type { SliceResult } from "../lib/slice";

const W = 21;
const H = 21;
const CX = 10;
const CY = 10;
const layerHeight = 0.1;
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
  rimHeightMm: 0.3,
}, { x: 1, y: 1 });

const at = (layer: number, dx: number, dy = 0) =>
  result.layers[layer].data[(CY + dy) * W + CX + dx];
const inMask = (layer: number, dx: number, dy = 0) =>
  mask[layer][(CY + dy) * W + CX + dx];

// The bottom is the widest part of the skate edge; the last floor layer
// narrows before the raised perimeter begins.
assert.equal(at(0, 4), 1, "bottom raft layer includes the outer spatula ledge");
assert.equal(at(2, 4), 0, "upper floor layer is narrower than the bottom ledge");

// Above the solid floor only the perimeter remains: a real printable tray,
// not a viewport-only decoration.
assert.equal(at(3, 3), 1, "raised perimeter exists above the raft floor");
assert.equal(inMask(3, 3), 1, "raised perimeter is recorded in the raft mask");
assert.equal(at(3, 1), 0, "tray interior is empty above the raft floor");
assert.equal(at(5, 3), 1, "rim height is converted to all requested layers");
assert.equal(at(6, 3), 0, "rim stops after the requested height");

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
  rimHeightMm: 0.3,
}, { x: 1, y: 1 });
assert.deepEqual(
  explicitlyDisabled.result.layers.map((layer) => layer.data),
  legacy.result.layers.map((layer) => layer.data),
  "disabled rim preserves the legacy flat raft exactly",
);

console.log("[OK] raft rim forms a tapered printable tray");
