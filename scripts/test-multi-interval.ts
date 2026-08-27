/** Regrese: dvě tělesa nad sebou nesmí depth slicer spojit výplní mezery. */
import { unzipSync } from "fflate";
import { makeBox } from "../lib/demo";
import { buildPm7FullRes } from "../lib/fullRes";
import type { PrinterProfile } from "../lib/profiles";
import { translateMesh } from "../lib/transform";

function whitePixels(data: Uint8Array): number {
  let i = 0;
  let white = 0;
  while (i < data.length) {
    const b = data[i];
    const color = b >> 4;
    const count = color === 0 || color === 15
      ? ((b & 15) << 8) | data[i + 1]
      : b & 15;
    i += color === 0 || color === 15 ? 2 : 1;
    if (color === 15) white += count;
  }
  return white;
}

const printer: PrinterProfile = {
  id: "test",
  name: "Test",
  brand: "Test",
  resX: 64,
  resY: 32,
  printX: 40,
  printY: 20,
  printZ: 50,
  pixelXUm: 625,
  pixelYUm: 625,
  keySuffix: "pm7",
  keyImageFormat: "pw0Img",
};

(async () => {
  const bottom = makeBox(10, 4);
  const top = translateMesh(makeBox(10, 4), 0, 0, 8);
  const models = [bottom, top].map((m) => ({
    positions: m.positions,
    bounds: m.bounds,
    triangleCount: m.triangleCount,
    tx: 0,
    ty: 0,
  }));
  const result = await buildPm7FullRes(models, {
    layerHeight: 1,
    hollow: false,
    wallMm: 2,
    holeDiaMm: 3,
    drainHoles: false,
    supports: false,
    supportRadiusMm: 1,
    supportTipMm: 0.5,
    raft: false,
    raftLayers: 3,
    raftMarginMm: 3,
    aa: false,
  }, printer, models, {});
  const files = unzipSync(result.bytes);
  const lower = whitePixels(files["layer_images/layer_1.pw0Img"]);
  const gap = whitePixels(files["layer_images/layer_5.pw0Img"]);
  const upper = whitePixels(files["layer_images/layer_9.pw0Img"]);
  if (!(lower > 0 && upper > 0 && gap === 0)) {
    throw new Error(`Chybný multi-interval: lower=${lower}, gap=${gap}, upper=${upper}`);
  }
  console.log("PASS multi-interval", { lower, gap, upper });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
