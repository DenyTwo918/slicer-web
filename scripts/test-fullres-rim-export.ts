import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import { makeBox } from "../lib/demo";
import { buildPm7FullRes } from "../lib/fullRes";
import { initNative } from "../lib/native";
import { translateMesh } from "../lib/transform";

function decodeRle4(data: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let src = 0;
  let dst = 0;
  while (src < data.length && dst < size) {
    const b = data[src];
    const color = b >> 4;
    let count: number;
    if (color === 0 || color === 0xf) {
      count = ((b & 0xf) << 8) | data[src + 1];
      src += 2;
    } else {
      count = b & 0xf;
      src += 1;
    }
    if (color === 0xf) out.fill(1, dst, dst + count);
    dst += count;
  }
  assert.equal(dst, size, "decoded native layer has printer resolution");
  return out;
}

(async () => {
  await initNative();
  const printer = { resX: 64, resY: 64, printX: 32, printY: 32 };
  const mesh = makeBox(16, 1);
  const model = {
    positions: mesh.positions,
    bounds: mesh.bounds,
    triangleCount: mesh.triangleCount,
    tx: 0,
    ty: 0,
  };
  const built = await buildPm7FullRes([model], {
    layerHeight: 0.1,
    hollow: false,
    wallMm: 2,
    holeDiaMm: 3,
    drainHoles: false,
    supports: false,
    supportRadiusMm: 1,
    supportTipMm: 0.5,
    raft: true,
    raftLayers: 2,
    raftMarginMm: 2,
    raftRim: true,
    raftRimWidthMm: 2,
    raftRimHeightMm: 0.3,
    aa: false,
  }, printer as any, [{ bounds: mesh.bounds }], {});
  const zip = unzipSync(built.bytes);
  const layer = (i: number) => decodeRle4(zip[`layer_images/layer_${i}.pw0Img`], 64 * 64);
  const at = (bitmap: Uint8Array, x: number, y = 32) => bitmap[y * 64 + x];

  assert.equal(at(layer(0), 55), 1, "native bottom layer exports the outer spatula ledge");
  assert.equal(at(layer(1), 55), 0, "native floor narrows toward the raised rim");
  assert.equal(at(layer(2), 53), 1, "native export contains the raised perimeter");
  assert.equal(at(layer(2), 50), 0, "native export leaves the tray interior open above its floor");
  assert.equal(at(layer(4), 53), 1, "native rim reaches the configured height");
  assert.equal(at(layer(5), 53), 0, "native rim stops at the configured height");

  const zeroWidth = await buildPm7FullRes([model], {
    layerHeight: 0.1,
    hollow: false,
    wallMm: 2,
    holeDiaMm: 3,
    drainHoles: false,
    supports: false,
    supportRadiusMm: 1,
    supportTipMm: 0.5,
    raft: true,
    raftLayers: 2,
    raftMarginMm: 2,
    raftRim: true,
    raftRimWidthMm: 0,
    raftRimHeightMm: 0.3,
    aa: false,
  }, printer as any, [{ bounds: mesh.bounds }], {});
  const zeroZip = unzipSync(zeroWidth.bytes);
  const zeroLayer2 = decodeRle4(zeroZip["layer_images/layer_2.pw0Img"], 64 * 64);
  assert.equal(at(zeroLayer2, 52), 0, "zero-width rim is disabled identically in preview and PM7");

  const smallBase = makeBox(4, 0.2);
  const wideUpper = translateMesh(makeBox(16, 1), 0, 0, 1);
  const flaredModels = [smallBase, wideUpper].map((part) => ({
    positions: part.positions,
    bounds: part.bounds,
    triangleCount: part.triangleCount,
    tx: 0,
    ty: 0,
  }));
  const legacyFlared = await buildPm7FullRes(flaredModels, {
    layerHeight: 0.1,
    hollow: false,
    wallMm: 2,
    holeDiaMm: 3,
    drainHoles: false,
    supports: false,
    supportRadiusMm: 1,
    supportTipMm: 0.5,
    raft: true,
    raftLayers: 1,
    raftMarginMm: 1,
    raftRim: false,
    raftRimWidthMm: 2,
    raftRimHeightMm: 0.3,
    aa: false,
  }, printer as any, flaredModels.map((part) => ({ bounds: part.bounds })), {});
  const legacyFlaredZip = unzipSync(legacyFlared.bytes);
  const legacyFlaredLayer0 = decodeRle4(legacyFlaredZip["layer_images/layer_0.pw0Img"], 64 * 64);
  assert.equal(at(legacyFlaredLayer0, 49), 0, "disabled rim preserves the legacy layer-0 native raft footprint");

  const trayFlared = await buildPm7FullRes(flaredModels, {
    layerHeight: 0.1,
    hollow: false,
    wallMm: 2,
    holeDiaMm: 3,
    drainHoles: false,
    supports: false,
    supportRadiusMm: 1,
    supportTipMm: 0.5,
    raft: true,
    raftLayers: 1,
    raftMarginMm: 1,
    raftRim: true,
    raftRimWidthMm: 2,
    raftRimHeightMm: 0.3,
    aa: false,
  }, printer as any, flaredModels.map((part) => ({ bounds: part.bounds })), {});
  const trayFlaredZip = unzipSync(trayFlared.bytes);
  const trayFlaredLayer0 = decodeRle4(trayFlaredZip["layer_images/layer_0.pw0Img"], 64 * 64);
  assert.equal(at(trayFlaredLayer0, 49), 1, "active tray footprint includes wider geometry from the shared lower Z band");

  console.log("[OK] PM7 export contains the tapered raft tray");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
