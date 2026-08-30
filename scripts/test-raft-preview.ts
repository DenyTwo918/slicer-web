import assert from "node:assert/strict";
import { makeBox } from "../lib/demo";
import { runSlicePipeline } from "../lib/pipeline";

(async () => {
  const mesh = makeBox(6, 1);
  const sliced = await runSlicePipeline([{
    positions: mesh.positions,
    bounds: mesh.bounds,
    triangleCount: mesh.triangleCount,
    tx: 0,
    ty: 0,
  }], {
    layerHeight: 0.1,
    hollow: false,
    wallMm: 2,
    holeDiaMm: 3,
    drainHoles: false,
    supports: false,
    supportRadiusMm: 1,
    supportTipMm: 0.5,
    raft: true,
    raftLayers: 3,
    raftMarginMm: 2,
    raftRim: true,
    raftRimWidthMm: 2,
    raftRimHeightMm: 0.3,
    aa: false,
  }, {
    resX: 50,
    resY: 50,
    printX: 25,
    printY: 25,
  }, { forceCpu: true });

  const masks = sliced.supportPreview?.raftLayerMasks;
  assert.ok(masks, "pipeline exposes printable raft layers to the viewport");
  assert.equal(masks.length, 6, "preview receives three floor and three rim layers");
  assert.ok(masks[0].some(Boolean), "preview bottom raft mask is populated");
  assert.ok(masks[5].some(Boolean), "preview top rim mask is populated");

  console.log("[OK] raft tray layers reach the viewport preview");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
