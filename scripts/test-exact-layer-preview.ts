import assert from "node:assert/strict";
import { zipSync } from "fflate";
import {
  encodeLayerCropToMachineInternal,
  encodeLayerToMachineInternal,
  encodeRlePw0,
} from "../lib/pm7";
import {
  buildNativeLayerPreview,
  decodePw0Crop,
  openPm7PreviewArchive,
} from "../lib/exactLayerPreview";
import { getPrinter } from "../lib/profiles";
import { bitmapPointToPlate, meshCenterOffset } from "../lib/previewCoordinates";
import { decodePw0Layer } from "../lib/anycubicLayer";

const m7 = getPrinter("m7");
assert.equal(m7.resX, 13312, "Photon Mono M7 must use its native 14K X resolution");
assert.equal(m7.resY, 5120);

const width = 8;
const height = 5;
const pixels = new Uint8Array(width * height);

// Two separate rows and a gray AA pixel: the crop must preserve both position
// and grayscale while avoiding a full printer-resolution allocation.
pixels[1 * width + 2] = 255;
pixels[1 * width + 3] = 255;
pixels[2 * width + 4] = 119;
pixels[3 * width + 5] = 255;

const encoded = encodeRlePw0(pixels);
const encodedFull = encodeLayerToMachineInternal(pixels, width, height, m7);
const encodedCrop = encodeLayerCropToMachineInternal(
  pixels,
  width,
  height,
  m7,
  { minX: 2, minY: 1, maxX: 5, maxY: 3, count: 4 }
);
assert.deepEqual(
  decodePw0Layer(encodedCrop, width * height),
  decodePw0Layer(encodedFull, width * height),
  "cropped encoder must preserve every native printer pixel"
);
const crop = decodePw0Crop(encoded, width, height);
assert.deepEqual(
  { width: crop.width, height: crop.height, offsetX: crop.offsetX, offsetY: crop.offsetY },
  { width: 4, height: 3, offsetX: 2, offsetY: 1 }
);
assert.deepEqual(
  [...crop.data],
  [255, 255, 0, 0, 0, 0, 119, 0, 0, 0, 0, 255]
);

const archiveBytes = zipSync({
  "layer_images/layer_1.pw0Img": encoded,
  "layer_images/layer_0.pw0Img": encodeRlePw0(new Uint8Array(width * height)),
});
const archive = openPm7PreviewArchive(archiveBytes, width, height);
assert.equal(archive.layerCount, 2);
assert.deepEqual(archive.layers[1], encoded);
assert.equal(archive.resX, width);
assert.equal(archive.resY, height);

const slice = {
  layers: [{ index: 0, z: 0.05, data: new Uint8Array([1]) }, { index: 1, z: 0.15, data: new Uint8Array([1]) }],
  layerHeight: 0.1,
  resolutionX: 1,
  resolutionY: 1,
  minX: 0,
  minY: 0,
};
const clipOnly = buildNativeLayerPreview(slice, null, 1);
assert.equal(clipOnly?.z, 0.15);
assert.equal(clipOnly?.data.length, 0, "in-flight full-res preview must still provide a clipping plane");
assert.equal(clipOnly?.resX, 0);

const exact = buildNativeLayerPreview(slice, archive, 1);
assert.equal(exact?.z, 0.15);
assert.equal(exact?.resX, 4);
assert.equal(exact?.fullResX, width);

const mapped = bitmapPointToPlate(
  { x: 25, y: 75 },
  { offsetX: 0, offsetY: 0, fullWidth: 100, fullHeight: 100 },
  { printX: 100, printY: 100 }
);
assert.deepEqual(mapped, { x: -25, y: 25 }, "bitmap Y must not be mirrored in the 3D scene");

assert.deepEqual(
  meshCenterOffset({ min: [10, 20, 0], max: [30, 60, 18] }),
  { x: -20, y: -40 },
  "viewport must center the same non-origin mesh bounds as the slicer"
);

const empty = decodePw0Crop(archive.layers[0], width, height);
assert.equal(empty.width, 0);
assert.equal(empty.height, 0);
assert.equal(empty.data.length, 0);

assert.throws(
  () => openPm7PreviewArchive(zipSync({ "layer_images/layer_2.pw0Img": encoded }), width, height),
  /contiguous/
);

console.log("exact layer preview tests passed");
