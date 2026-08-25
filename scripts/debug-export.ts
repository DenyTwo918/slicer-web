import { makeBox } from "../lib/demo";
import { sliceMesh } from "../lib/slice";
import { encodeSceneSlice } from "../lib/pm7";

const mesh = makeBox(40, 60);
const slice = sliceMesh(mesh, { layerHeight: 0.1, resolutionX: 1664, resolutionY: 640 });

// 1) raster vrstvy 300
const L = slice.layers[300];
let count = 0, minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
for (let y = 0; y < 640; y++) {
  for (let x = 0; x < 1664; x++) {
    if (L.data[y * 1664 + x]) {
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
}
console.log("[1] Vrstva 300 raster:", count, "px z", 1664 * 640, "· bbox x", minX, "-", maxX, " y", minY, "-", maxY);
console.log("   ocekavany ctverec 40mm: x ~", 1664 / 2 - 2381 / 2 / 8, "-", 1664 / 2 + 2381 / 2 / 8, "(x8)");

// 2) scene.slice parsin
const info = slice.layers.map((l) => ({ z: l.z, areaMm2: 1, x0: 0, y0: 0, x1: 1, y1: 1 }));
const scene = encodeSceneSlice({ layerCount: slice.layers.length, bounds: mesh.bounds, layers: info });
const dv = new DataView(scene.buffer, scene.byteOffset, scene.byteLength);
const u32 = (o: number) => dv.getUint32(o, true);
const f32 = (o: number) => dv.getFloat32(o, true);
console.log("\n[2] scene.slice delka:", scene.length);
console.log("   magic:", String.fromCharCode(...scene.slice(0, 16)).replace(/\0/g, "|"));
console.log("   software:", String.fromCharCode(...scene.slice(16, 24)).replace(/\0/g, ""));
console.log("   BinaryType:", u32(80), "· Version:", u32(84), "· SliceType:", u32(88), "· ModelUnit:", u32(92));
console.log("   PointRatio:", f32(96), "· LayerCount:", u32(100));
console.log("   XStart:", f32(104), "YStart:", f32(108), "ZMin:", f32(112), "XEnd:", f32(116), "YEnd:", f32(120), "ZMax:", f32(124));
console.log("   ModelStats:", u32(128));
console.log("   separator:", String.fromCharCode(...scene.slice(388, 392)).replace(/\0/g, ""));
console.log("   LayerDefCount:", u32(392));
console.log("   prvni def Height/Area:", f32(396), "/", f32(400));
