import { strict as assert } from "node:assert";
import { applyHollow, carveDrainHolesInPlace, type DrainAnchor } from "../lib/hollow";
import type { SliceResult } from "../lib/slice";

function solidBox(width: number, height: number, layerCount: number, layerHeight = 0.1): SliceResult {
  return {
    resolutionX: width,
    resolutionY: height,
    layerHeight,
    minX: 0,
    minY: 0,
    layers: Array.from({ length: layerCount }, (_, index) => ({
      index,
      z: (index + 0.5) * layerHeight,
      data: new Uint8Array(width * height).fill(1),
    })),
  };
}

function twoDisconnectedBoxes(width: number, height: number, layerCount: number, layerHeight = 0.1): SliceResult {
  const slice = solidBox(width, height, layerCount, layerHeight);
  for (const layer of slice.layers) {
    layer.data.fill(0);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x <= 9; x++) layer.data[y * width + x] = 1;
      for (let x = width - 10; x < width - 1; x++) layer.data[y * width + x] = 1;
    }
  }
  return slice;
}

const W = 17;
const H = 17;
const center = 8 * W + 8;
const solid = solidBox(W, H, 12);
const options = { enabled: true, wallMm: 0.2, holeDiaMm: 0.8, drainHoles: true };
const noDrains = applyHollow(solid, { ...options, drainHoles: false }, { x: 0.2, y: 0.1 });
let anchors: DrainAnchor[] = [];
const drained = applyHollow(solid, options, { x: 0.2, y: 0.1 }, (found) => { anchors = found; });
const bottomAnchor = anchors.find((anchor) => anchor.direction === "bottom");
const topAnchor = anchors.find((anchor) => anchor.direction === "top");
assert.ok(bottomAnchor, "bottom drain anchor is explicit");
assert.ok(topAnchor, "top drain anchor is explicit");

assert.equal(noDrains.layers[0].data[center], 1, "bottom shell exists before drain carving");
assert.equal(noDrains.layers[11].data[center], 1, "top shell exists before drain carving");

// The same XY coordinate must be open continuously from the bottom exterior,
// through the cavity, to the top exterior. A one-layer disc cannot pass this.
for (let layer = 0; layer < drained.layers.length; layer++) {
  assert.equal(drained.layers[layer].data[center], 0, `drain path is continuous at layer ${layer}`);
}

// Pozdější support/raft může otvor překrýt; finální re-carve ho musí otevřít.
for (let layer = 0; layer <= bottomAnchor.layer; layer++) drained.layers[layer].data[center] = 1;
for (let layer = topAnchor.layer; layer < drained.layers.length; layer++) drained.layers[layer].data[center] = 1;
// Re-carving must use the explicit direction rather than the array position.
carveDrainHolesInPlace(drained, [topAnchor, bottomAnchor], options.holeDiaMm, { x: 0.2, y: 0.1 });
for (let layer = 0; layer <= bottomAnchor.layer; layer++) {
  assert.equal(drained.layers[layer].data[center], 0, `final drain re-carve at layer ${layer}`);
}
for (let layer = topAnchor.layer; layer < drained.layers.length; layer++) {
  assert.equal(drained.layers[layer].data[center], 0, `final top drain re-carve at layer ${layer}`);
}

const directionProbe = solidBox(9, 5, 5);
carveDrainHolesInPlace(directionProbe, [
  { x: 2, y: 2, layer: 3, direction: "top" },
  { x: 6, y: 2, layer: 1, direction: "bottom" },
], 0.2, { x: 0.1, y: 0.1 });
for (let layer = 0; layer < directionProbe.layers.length; layer++) {
  assert.equal(directionProbe.layers[layer].data[2 * 9 + 2], layer >= 3 ? 0 : 1, `top direction at layer ${layer}`);
  assert.equal(directionProbe.layers[layer].data[2 * 9 + 6], layer <= 1 ? 0 : 1, `bottom direction at layer ${layer}`);
}

// 0.8 mm diameter with 0.2 x 0.1 mm pixels is an ellipse of radii 2 x 4 px.
const bottom = drained.layers[0].data;
assert.equal(bottom[8 * W + 10], 0, "physical X radius is carved");
assert.equal(bottom[8 * W + 11], 1, "drain does not exceed physical X radius");
assert.equal(bottom[12 * W + 8], 0, "physical Y radius is carved");
assert.equal(bottom[13 * W + 8], 1, "drain does not exceed physical Y radius");

// If erosion produced no cavity, automatic drainage must not damage the solid.
const tooThin = solidBox(7, 7, 4);
const tooThinDrained = applyHollow(tooThin, options, { x: 0.1, y: 0.1 });
for (let layer = 0; layer < tooThin.layers.length; layer++) {
  assert.deepEqual(tooThinDrained.layers[layer].data, tooThin.layers[layer].data);
}

// Each sealed, disconnected cavity needs its own bottom and top channel. A
// global centroid finds only one pair (and tie-breaking puts both in the left box).
const separated = twoDisconnectedBoxes(25, 11, 12);
let separatedAnchors: DrainAnchor[] = [];
const separatedDrained = applyHollow(
  separated,
  { enabled: true, wallMm: 0.1, holeDiaMm: 0.2, drainHoles: true },
  { x: 0.1, y: 0.1 },
  (found) => { separatedAnchors = found; },
);
assert.equal(separatedAnchors.length, 4, "each disconnected cavity gets bottom and top drain anchors");
assert.equal(separatedAnchors.filter((anchor) => anchor.x < 12).length, 2, "left cavity gets two anchors");
assert.equal(separatedAnchors.filter((anchor) => anchor.x > 12).length, 2, "right cavity gets two anchors");
assert.equal(separatedAnchors.filter((anchor) => anchor.direction === "bottom").length, 2, "one bottom anchor per cavity");
assert.equal(separatedAnchors.filter((anchor) => anchor.direction === "top").length, 2, "one top anchor per cavity");
for (const anchor of separatedAnchors) {
  const face = anchor.direction === "bottom" ? 0 : 11;
  assert.equal(separatedDrained.layers[face].data[anchor.y * 25 + anchor.x], 0, `${anchor.direction} drain reaches its face`);
}

console.log("PASS drain holes");
