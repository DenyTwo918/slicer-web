import assert from "node:assert/strict";
import { simplifyClosedPreviewContour, traceMaskContours } from "../lib/previewContour";

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

// Dva pixely dotýkající se pouze rohem nesmějí vytvořit jednu samoprotínající
// smyčku. Právě ta dříve produkovala obří modré trojúhelníky přes Benchy.
const diagonal = new Uint8Array([1, 0, 0, 1]);
const diagonalLoops = traceMaskContours(diagonal, 2, 2);
assert.equal(diagonalLoops.length, 2, "corner-touching components remain separate contours");
assert.deepEqual(diagonalLoops.map((loop) => loop.length).sort(), [4, 4]);
console.log("PASS diagonal contour topology");
