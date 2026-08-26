import { makeBox, makeTorus } from "../lib/demo";
import { sliceMesh, unionSlices } from "../lib/slice";
import { applyHollow } from "../lib/hollow";
import { generateSupports } from "../lib/supports";
import { applyRaft } from "../lib/raft";
import { applyAA } from "../lib/aa";
import { translateMesh } from "../lib/transform";

const t0 = Date.now();
const cube = makeBox(40, 60);
const torus = translateMesh(makeTorus(), 0, 0, 12);
const scale = 16;
const sliceW = 11520 / scale; // M7 12K /16 = 720
const sliceH = 5120 / scale; // 320
const mmPerPx = { x: 223.642 / sliceW, y: 126.48 / sliceH };

let result: any = null;
for (const m of [cube, torus]) {
  const s = sliceMesh(m, {
    layerHeight: 0.1,
    resolutionX: sliceW,
    resolutionY: sliceH,
    plateW: 223.642,
    plateH: 126.48,
    offsetX: m === torus ? -70 : 0,
    offsetY: 0,
  });
  result = result ? unionSlices(result, s) : s;
}
console.log("slice:", result.layers.length, "vrstev za", Date.now() - t0, "ms");

const t1 = Date.now();
result = applyHollow(result, { enabled: true, wallMm: 2, holeDiaMm: 3, drainHoles: true }, mmPerPx);
console.log("hollow za", Date.now() - t1, "ms");

const t2 = Date.now();
result = generateSupports(result, { enabled: true, radiusPx: 4, tipPx: 2 });
console.log("supports za", Date.now() - t2, "ms");

const t3 = Date.now();
result = applyRaft(result, { enabled: true, layers: 3, marginMm: 3 }, mmPerPx);
console.log("raft za", Date.now() - t3, "ms");

const t4 = Date.now();
result = applyAA(result);
console.log("AA za", Date.now() - t4, "ms");

console.log("CELKEM za", Date.now() - t0, "ms");
console.log("HOTOVO bez chyby");
