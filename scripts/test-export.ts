/**
 * End-to-end test exportu .pm7 v Node (bez prohlížeče).
 * Spustit: npx tsx scripts/test-export.ts
 */
import { writeFileSync } from "fs";
import { makeBox } from "../lib/demo";
import { sliceMesh } from "../lib/slice";
import { buildPm7 } from "../lib/pm7";
import { unzipSync } from "fflate";

const MX = 13312;
const MY = 5120;

// port DecodePW0 (UVtools AnycubicFile.cs:2549) — pro nezávislé ověření
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
    if (pixelPos + repeat > imgLen) throw new Error("run pres konec obrazu");
    out.fill(color, pixelPos, pixelPos + repeat);
    pixelPos += repeat;
    if (pixelPos === imgLen) break;
  }
  if (pixelPos !== imgLen) throw new Error("obraz skoncil kratce: " + pixelPos);
  return out;
}

async function main() {
  const mesh = makeBox(40, 60);
  const slice = sliceMesh(mesh, {
    layerHeight: 0.1,
    resolutionX: 1664,
    resolutionY: 640,
    plateW: 223.64,
    plateH: 126.48,
  });
  console.log("Vrstev:", slice.layers.length, "· z-rozsah:", mesh.bounds.min[2], "-", mesh.bounds.max[2], "mm");

  const t0 = Date.now();
  const bytes = await buildPm7(mesh, slice, { modelName: "cube" });
  console.log("Export OK:", bytes.length, "B za", Date.now() - t0, "ms");
  writeFileSync("test-output.pm7", bytes);

  // 1) kontrola ZIP obsahu
  const files = unzipSync(bytes);
  const names = Object.keys(files);
  console.log("\n[1] Entries v ZIPu:", names.length);
  const required = [
    "anycubic_photon_resins.pwsp",
    "layers_controller.conf",
    "print_info.json",
    "software_info.conf",
    "scene.slice",
    "preview_images/preview_0.png",
    "preview_images/preview_1.png",
    "layer_images/layer_0.pw0Img",
    "layer_images/layer_599.pw0Img",
  ];
  for (const r of required) {
    if (!names.includes(r)) {
      console.log("CHYBI:", r);
      process.exit(1);
    }
  }
  console.log("Vsechny povinne soubory OK");

  // 2) velikosti vrstev (sance na nesmysl)
  const sizes = names
    .filter((n) => n.startsWith("layer_images/"))
    .map((n) => files[n].length);
  console.log(
    "\n[2] Velikost vrstev: min",
    Math.min(...sizes),
    "B · prumer",
    Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
    "B · max",
    Math.max(...sizes),
    "B"
  );

  // 3) dekodovani vrstvy uprostred tisku (krychle 40x40mm)
  const mid = Math.floor(slice.layers.length / 2);
  const rle = files[`layer_images/layer_${mid}.pw0Img`];
  const img = decodePW0(rle, MX * MY);
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
  const hmm = ((maxY - minY + 1) * 24.8) / 1000;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  console.log("\n[3] Vrstva", mid, ":");
  console.log("   nenulovych pixelu:", count);
  console.log("   rozmer:", wmm.toFixed(1), "x", hmm.toFixed(1), "mm (ocekavani ~40 x 40 mm)");
  console.log("   stred:", cx.toFixed(0), ",", cy.toFixed(0), "(stred desky 6656, 2560)");
  const ok =
    Math.abs(wmm - 40) < 1.5 &&
    Math.abs(hmm - 40) < 1.5 &&
    Math.abs(cx - 6656) < 20 &&
    Math.abs(cy - 2560) < 20;
  console.log(ok ? "   [OK] rozmer i poloha sedi" : "   [CHYBA] nesedi");

  // 4) scene.slice delka (hlavicka + per-vrstva 64 B)
  const scene = files["scene.slice"];
  const expected = 16 + 64 + 13 * 4 + 64 * 4 + 4 + 4 + slice.layers.length * 64 + 4;
  console.log(
    "\n[4] scene.slice:", scene.length, "B (ocekavani ~", expected, "B)",
    Math.abs(scene.length - expected) <= 8 ? "[OK]" : "[pozor — jiná délka]"
  );
}

main().catch((e) => {
  console.error("\nCHYBA:", e);
  process.exit(1);
});
