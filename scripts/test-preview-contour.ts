import assert from "node:assert/strict";
import { simplifyClosedPreviewContour } from "../lib/previewContour";

// Digitální diagonála vzniklá z low-res vrstvy. Zobrazovací obrys má odstranit
// střídající se vodorovné/svislé schody, ne však změnit raster zdroje pravdy.
const staircase = [
  { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 },
  { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 3 },
  { x: 4, y: 6 }, { x: 0, y: 6 },
];
const simplified = simplifyClosedPreviewContour(staircase, 0.75);
assert.ok(simplified.length < staircase.length, "preview contour removes visible pixel steps");
assert.ok(simplified.some((point) => point.x === 0 && point.y === 0), "outer extent is retained");
assert.ok(simplified.some((point) => point.x === 4), "opposite outer extent is retained");
assert.deepEqual(
  simplifyClosedPreviewContour(staircase, 0),
  staircase,
  "zero tolerance keeps the exact print contour",
);
console.log("PASS preview contour");
