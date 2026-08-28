/**
 * Real 12K hollow + smooth-raft export benchmark.
 * Timing is reported, never used as a CI gate; the memory guard is deliberately
 * broad and catches a return to 5*n WASM scratch plus per-pixel Uint32 indices.
 */
import assert from "node:assert/strict";
import { buildPm7FullRes } from "../lib/fullRes";
import { makeBox } from "../lib/demo";

const printer = { resX: 11520, resY: 5120, printX: 223.642, printY: 126.48 };
const mesh = makeBox(40, 3);
const models = [{
  positions: mesh.positions,
  bounds: mesh.bounds,
  triangleCount: mesh.triangleCount,
  tx: 0,
  ty: 0,
}];
const settings = {
  layerHeight: 0.5,
  hollow: true,
  wallMm: 1,
  holeDiaMm: 3,
  drainHoles: false,
  supports: false,
  supportRadiusMm: 1,
  supportTipMm: 0.5,
  supportMaxAngleDeg: 35,
  supportSpacingMm: 8,
  supportClearanceMm: 1,
  raft: true,
  raftLayers: 3,
  raftMarginMm: 3,
  aa: false,
};

async function main() {
  const baseline = process.memoryUsage().arrayBuffers;
  let observed = baseline;
  const started = performance.now();
  const result = await buildPm7FullRes(
    models,
    settings,
    printer as never,
    [{ bounds: mesh.bounds }],
    { onProgress: () => { observed = Math.max(observed, process.memoryUsage().arrayBuffers); } }
  );
  const elapsed = performance.now() - started;
  observed = Math.max(observed, process.memoryUsage().arrayBuffers);
  const retainedPeak = observed - baseline;

  assert.equal(result.layers, 6);
  assert.ok(result.bytes.length > 0);
  assert.ok(
    retainedPeak < 768 * 1024 * 1024,
    `12K hollow+raft retained ${(retainedPeak / 1024 / 1024).toFixed(1)} MiB of ArrayBuffers`
  );
  console.log(
    `[BENCH] 12K hollow+raft export: ${result.layers} layers, ` +
    `${(elapsed / 1000).toFixed(2)} s, observed ArrayBuffer delta ` +
    `${(retainedPeak / 1024 / 1024).toFixed(1)} MiB, PM7 ${(result.bytes.length / 1024 / 1024).toFixed(1)} MiB`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
