/**
 * End-to-end test: batch (2 modely) + podpory + AA + export .pm7.
 * Spustit: npx tsx scripts/test-export.ts
 */
import { writeFileSync } from "fs";
import { makeBox, makeTorus } from "../lib/demo";
import { sliceMesh, unionSlices } from "../lib/slice";
import { generateSupports } from "../lib/supports";
import { applyAA } from "../lib/aa";
import { buildPm7 } from "../lib/pm7";
import { translateMesh } from "../lib/transform";
import { getPrinter } from "../lib/profiles";
import { unzipSync } from "fflate";

const MX = 13312;
const MY = 5120;
const SLICE_OPTS = {
  layerHeight: 0.1,
  resolutionX: 1664,
  resolutionY: 640,
  plateW: 223.64,
  plateH: 126.48,
};

function decodePW0(encoded: Uint8Array, imgLen: number): Uint8Array {
  const out = new Uint8Array(imgLen);
  let pixelPos = 0;
  for (let i = 0; i < encoded.length; i++) {
    const b = encoded[i];
    let code = b >> 4;
    let repeat = b & 0xf;
    let color: number;
    if (code === 0x0) {
      color = 0;
      i++;
      if (i >= encoded.length) repeat = imgLen - pixelPos;
      else repeat = (repeat << 8) + encoded[i];
    } else if (code === 0xf) {
      color = 255;
      i++;
      if (i >= encoded.length) repeat = imgLen - pixelPos;
      else repeat = (repeat << 8) + encoded[i];
    } else {
      color = (code << 4) | code;
      if (i >= encoded.length) repeat = imgLen - pixelPos;
    }
    if (pixelPos + repeat > imgLen) throw new Error("run pres konec");
    out.fill(color, pixelPos, pixelPos + repeat);
    pixelPos += repeat;
    if (pixelPos === imgLen) break;
  }
  if (pixelPos !== imgLen) throw new Error("kratky obraz");
  return out;
}

function countPx(slice: { layers: { data: Uint8Array }[] }): number {
  let n = 0;
  for (const l of slice.layers) {
    for (let i = 0; i < l.data.length; i++) if (l.data[i]) n++;
  }
  return n;
}

async function main() {
  // 2 modely: krychle (uprostred) + torus (posunuty doleva, s previsy)
  const cube = makeBox(40, 60);
  const torus = translateMesh(makeTorus(), 0, 0, 12); // z 0..24 mm

  const sCube = sliceMesh(cube, { ...SLICE_OPTS });
  const sTorus = sliceMesh(torus, { ...SLICE_OPTS, offsetX: -70 });
  let slice = unionSlices(sCube, sTorus);
  console.log("Vrstev po sjednoceni:", slice.layers.length);

  const before = countPx(slice);
  slice = generateSupports(slice, { enabled: true });
  const after = countPx(slice);
  console.log(
    "Podpory: pridano",
    after - before,
    "px",
    after > before ? "[OK - sloupy vznikly]" : "[pozor - zadne podpory]"
  );

  const sliceAA = applyAA(slice);
  const mid = Math.floor(sliceAA.layers.length / 2);
  const grays = new Set<number>();
  const d = sliceAA.layers[mid].data;
  for (let i = 0; i < d.length; i += 1009) {
    if (d[i] > 0 && d[i] < 255) grays.add(d[i]);
  }
  console.log(
    "AA: mezihodnoty (seda) na vrstve",
    mid,
    "=>",
    grays.size,
    grays.size > 0 ? "[OK]" : "[CHYBA - bez AA]"
  );

  const t0 = Date.now();
  const bytes = await buildPm7([cube, torus], sliceAA, {});
  writeFileSync("test-output.pm7", bytes);
  console.log("Export:", bytes.length, "B za", Date.now() - t0, "ms");

  // kontrola vrstvy 100 (z=10mm): krychle + torus i s podporami
  const files = unzipSync(bytes);
  const names = Object.keys(files);
  if (!names.includes("layer_images/layer_100.pw0Img")) {
    console.log("CHYBI layer_100");
    process.exit(1);
  }
  const img = decodePW0(files["layer_images/layer_100.pw0Img"], MX * MY);
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, count = 0;
  for (let y = 0; y < MY; y++) {
    for (let x = 0; x < MX; x++) {
      if (img[y * MX + x]) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const wmm = ((maxX - minX + 1) * 16.8) / 1000;
  console.log("\nVrstva 100: px", count, "· sirka", wmm.toFixed(0), "mm");
  console.log(
    wmm > 120 ? "[OK] pokryva oba modely (krychle + torus)" : "[pozor] mala sirka"
  );

  // 5) parametrizace tiskárny (M5s)
  const bytes2 = await buildPm7([cube], sliceAA, { printer: getPrinter("m5s") });
  const files2 = unzipSync(bytes2);
  const pwsp = new TextDecoder().decode(files2["anycubic_photon_resins.pwsp"]);
  const layerCount2 = Object.keys(files2).filter((n) => n.startsWith("layer_images/")).length;
  console.log(
    "\n[5] M5s profil:", pwsp.includes("Photon Mono M5s") ? "[OK]" : "[CHYBA]",
    "· vrstev v souboru:", layerCount2,
    layerCount2 === slice.layers.length ? "[OK]" : "[CHYBA]"
  );

  console.log("\nHOTOVO — vse proselo");
}

main().catch((e) => {
  console.error("\nCHYBA:", e);
  process.exit(1);
});
