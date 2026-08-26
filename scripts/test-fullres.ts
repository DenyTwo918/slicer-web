/**
 * Test full-res (12K) streaming exportu.
 * Krychle 40 mm → .pm7 v nativním rozlišení 11520×5120.
 * Spuštění: NODE_OPTIONS=--max-old-space-size=6144 npx tsx scripts/test-fullres.ts
 */
import { buildPm7FullRes } from "../lib/fullRes";
import { makeBox } from "../lib/demo";
import { unzipSync } from "fflate";

const PRINTER = { resX: 11520, resY: 5120, printX: 223.642, printY: 126.48 };

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};

/** Dekóduje RLE4 → vrátí počet pixelů celkem a počet bílých (barva 15). */
function decodeRle4(data: Uint8Array): { total: number; white: number } {
  let i = 0;
  let total = 0;
  let white = 0;
  while (i < data.length) {
    const b = data[i];
    const color = b >> 4;
    let done: number;
    if (color === 0 || color === 0xf) {
      done = ((b & 0xf) << 8) | data[i + 1];
      i += 2;
    } else {
      done = b & 0xf;
      i += 1;
    }
    total += done;
    if (color === 0xf) white += done;
  }
  return { total, white };
}

(async () => {
  await import("../lib/native").then((m) => m.initNative());

  // krychle 40×40 base, výška 12 mm, vrstvy 0.5 mm → 24 vrstev
  const mesh = makeBox(40, 12);
  const models = [
    {
      positions: mesh.positions,
      bounds: mesh.bounds,
      triangleCount: mesh.triangleCount,
      tx: 0,
      ty: 0,
    },
  ];
  const settings = {
    layerHeight: 0.5,
    hollow: false,
    wallMm: 2,
    holeDiaMm: 3,
    drainHoles: true,
    supports: false,
    supportRadiusMm: 1,
    supportTipMm: 0.5,
    supportMaxAngleDeg: 35,
    supportSpacingMm: 8,
    supportClearanceMm: 1,
    raft: false,
    raftLayers: 3,
    raftMarginMm: 3,
    aa: false,
  };

  const t0 = Date.now();
  const res = await buildPm7FullRes(
    models,
    settings,
    PRINTER as any,
    [{ bounds: mesh.bounds }],
    {}
  );
  const dt = Date.now() - t0;
  console.log(`export: ${res.layers} vrstev, ${(res.bytes.length / 1024 / 1024).toFixed(1)} MB, ${dt} ms`);

  const files = unzipSync(res.bytes);
  check("scene.slice existuje", !!files["scene.slice"]);
  check("layers_controller.conf existuje", !!files["layers_controller.conf"]);
  check("print_info.json existuje", !!files["print_info.json"]);
  check("počet pw0Img souborů", Object.keys(files).filter((f) => f.endsWith(".pw0Img")).length === 24);

  // dekódování vrstvy 10 (uprostřed — plný průřez krychle)
  const mid = files["layer_images/layer_10.pw0Img"];
  const d = decodeRle4(mid);
  const expectedPx = PRINTER.resX * PRINTER.resY; // 58 982 400
  check(
    `dekódovaná velikost = native res (${expectedPx})`,
    d.total === expectedPx,
    `${d.total}`
  );
  // krychle 40 mm na 223.642 mm desce = 17.9 % plochy → ~10.5M bílých px
  const expectedWhite = Math.round((40 / PRINTER.printX) * PRINTER.resX * (40 / PRINTER.printY) * PRINTER.resY);
  const ratio = d.white / expectedWhite;
  check(
    "bílé pixely ≈ průřez krychle (±2 %)",
    Math.abs(ratio - 1) < 0.02,
    `bílá ${d.white} vs očekáváno ${expectedWhite} (${(ratio * 100).toFixed(1)} %)`
  );

  console.log(fails === 0 ? "\nHOTOVO — vse proselo" : `\n${fails} NESHOD`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL:", e.message ?? e);
  process.exit(1);
});
