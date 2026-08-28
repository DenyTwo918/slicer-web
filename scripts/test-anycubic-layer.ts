import assert from "node:assert/strict";
import { decodePw0Layer } from "../lib/anycubicLayer";

const decoded = decodePw0Layer(
  new Uint8Array([
    0x00, 0x03, // 3 black pixels
    0x72,       // 2 pixels at grayscale nibble 7
    0xf0, 0x04, // 4 white pixels
  ]),
  9
);

assert.deepEqual(
  [...decoded],
  [0, 0, 0, 0x77, 0x77, 255, 255, 255, 255],
  "PW0 must decode black/gray/white RLE4 runs exactly"
);

assert.throws(
  () => decodePw0Layer(new Uint8Array([0xf0, 0x04]), 3),
  /runs past the expected image size/,
  "PW0 must reject a run that exceeds the target image"
);

assert.throws(
  () => decodePw0Layer(new Uint8Array([0x72]), 3),
  /ended after 2 of 3 pixels/,
  "PW0 must reject truncated layers"
);

console.log("Anycubic layer decoder tests passed");
