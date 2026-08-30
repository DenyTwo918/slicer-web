import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { applyRaft } from "../lib/raft";
import type { SliceResult } from "../lib/slice";

const W = 832;
const H = 320;
const layerHeight = 0.02;
const layerCount = 104;
const footprint = new Uint8Array(W * H);
for (let y = 60; y < 260; y++) {
  footprint.fill(1, y * W + 166, y * W + 666);
}
const slice: SliceResult = {
  resolutionX: W,
  resolutionY: H,
  layerHeight,
  minX: -66,
  minY: -40,
  layers: Array.from({ length: layerCount }, (_, index) => ({
    index,
    z: (index + 0.5) * layerHeight,
    data: footprint,
  })),
};

const started = performance.now();
applyRaft(slice, {
  enabled: true,
  layers: 3,
  marginMm: 2,
  rimEnabled: true,
  rimWidthMm: 1,
  rimHeightMm: 2,
}, { x: 132 / W, y: 80 / H });
const elapsed = performance.now() - started;

assert.ok(elapsed < 2_500, `dense M7 2 mm rim took ${elapsed.toFixed(0)} ms (limit 2500 ms)`);
console.log(`[OK] dense M7 2 mm rim ${elapsed.toFixed(0)} ms`);
