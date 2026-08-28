import { makeBox } from "../lib/demo";
import { sliceMesh } from "../lib/slice";
import { applyHollow } from "../lib/hollow";
import { applyRaft } from "../lib/raft";
import assert from "node:assert/strict";

const mesh = makeBox(40, 60); // kvádr 40x40x60
const slice = sliceMesh(mesh, { layerHeight: 0.5, resolutionX: 1440, resolutionY: 640, plateW: 223.642, plateH: 126.48 });
const mmPerPx = { x: 223.642 / 1440, y: 126.48 / 640 };

function count(l: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < l.length; i++) if (l[i]) n++;
  return n;
}

const mid = Math.floor(slice.layers.length / 2);
const before = count(slice.layers[mid].data);
console.log("Vrstva", mid, "plna:", before, "px");

// hollowing
const hollowed = applyHollow(slice, { enabled: true, wallMm: 3, holeDiaMm: 4, drainHoles: true }, mmPerPx);
const after = count(hollowed.layers[mid].data);
console.log("Po hollowingu:", after, "px (odstraneno:", before - after, ")");
console.log(after < before * 0.7 ? "[OK] vnitrek odstranen" : "[POZOR] hollowing neodstranil dost");

// Fyzicka tloustka steny musi byt stejna i pri ruznem X/Y pixel pitch.
// Pri 1 mm stene je polomer eroze 5 px v X (0,2 mm/px), ale 10 px v Y
// (0,1 mm/px). Sdileny 10px polomer by chybne vytvoril 2mm stenu v X.
const anisotropicW = 25;
const anisotropicH = 25;
const anisotropicLayers = Array.from({ length: 3 }, (_, index) => ({
  index,
  z: index + 0.5,
  data: new Uint8Array(anisotropicW * anisotropicH).fill(1),
}));
const anisotropic = applyHollow(
  {
    layers: anisotropicLayers,
    layerHeight: 1,
    resolutionX: anisotropicW,
    resolutionY: anisotropicH,
    minX: 0,
    minY: 0,
  },
  { enabled: true, wallMm: 1, holeDiaMm: 0, drainHoles: false },
  { x: 0.2, y: 0.1 },
);
const anisotropicMid = anisotropic.layers[1].data;
assert.equal(anisotropicMid[12 * anisotropicW + 4], 1, "X stena ma zustat 1 mm tlusta");
assert.equal(anisotropicMid[12 * anisotropicW + 5], 0, "X dutina ma zacit po 5 pixelech");
assert.equal(anisotropicMid[9 * anisotropicW + 12], 1, "Y stena ma zustat 1 mm tlusta");
assert.equal(anisotropicMid[10 * anisotropicW + 12], 0, "Y dutina ma zacit po 10 pixelech");
console.log("[OK] hollow drzi fyzickou tloustku pri anisotropnim pixel pitch");

// raft
const rafted = applyRaft(hollowed, { enabled: true, layers: 3, marginMm: 3 }, mmPerPx).result;
const bottom0 = count(rafted.layers[0].data);
const orig0 = count(slice.layers[0].data);
console.log("\nRaft: vrstva 0 pred", orig0, "px, po raftu", bottom0, "px");
console.log(bottom0 > orig0 ? "[OK] raft zvetsil zakladnu" : "[POZOR] raft nepribyl");

// Raft margin must also preserve millimetres on anisotropic pixels.
const raftW = 15;
const raftH = 15;
const raftSource = new Uint8Array(raftW * raftH);
raftSource[7 * raftW + 7] = 1;
const anisotropicRaft = applyRaft(
  {
    layers: [{ index: 0, z: 0.5, data: raftSource }],
    layerHeight: 1,
    resolutionX: raftW,
    resolutionY: raftH,
    minX: 0,
    minY: 0,
  },
  { enabled: true, layers: 1, marginMm: 1 },
  { x: 0.5, y: 0.25 },
).result.layers[0].data;
assert.equal(anisotropicRaft[7 * raftW + 9], 1, "raft X margin reaches 1 mm");
assert.equal(anisotropicRaft[7 * raftW + 10], 0, "raft X margin does not exceed 1 mm");
assert.equal(anisotropicRaft[11 * raftW + 7], 1, "raft Y margin reaches 1 mm");
assert.equal(anisotropicRaft[12 * raftW + 7], 0, "raft Y margin does not exceed 1 mm");
console.log("[OK] raft drzi fyzicky margin pri anisotropnim pixel pitch");

console.log("\nHOTOVO");

