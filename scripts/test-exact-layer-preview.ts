import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { encodeRlePw0 } from "../lib/pm7";
import { decodePw0Crop, openPm7PreviewArchive } from "../lib/exactLayerPreview";
import { getPrinter } from "../lib/profiles";

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

const empty = decodePw0Crop(archive.layers[0], width, height);
assert.equal(empty.width, 0);
assert.equal(empty.height, 0);
assert.equal(empty.data.length, 0);

assert.throws(
  () => openPm7PreviewArchive(zipSync({ "layer_images/layer_2.pw0Img": encoded }), width, height),
  /contiguous/
);

console.log("exact layer preview tests passed");
