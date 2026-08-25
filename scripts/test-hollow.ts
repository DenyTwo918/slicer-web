import { makeBox } from "../lib/demo";
import { sliceMesh } from "../lib/slice";
import { applyHollow } from "../lib/hollow";
import { applyRaft } from "../lib/raft";

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

// raft
const rafted = applyRaft(hollowed, { enabled: true, layers: 3, marginMm: 3 }, mmPerPx);
const bottom0 = count(rafted.layers[0].data);
const orig0 = count(slice.layers[0].data);
console.log("\nRaft: vrstva 0 pred", orig0, "px, po raftu", bottom0, "px");
console.log(bottom0 > orig0 ? "[OK] raft zvetsil zakladnu" : "[POZOR] raft nepribyl");

console.log("\nHOTOVO");
