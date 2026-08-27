/**
 * Test otočeného modelu (Benchy scénář): torus otočený na hranu →
 * raft musí pokrýt celou spodní stranu a podpory musí existovat.
 * Spuštění: npx tsx scripts/test-rotated.ts
 */
import { runSlicePipeline } from "../lib/pipeline";
import { makeTorus } from "../lib/demo";
import { rotateMesh, normalizeToPlate } from "../lib/transform";

const PRINTER = { resX: 11520, resY: 5120, printX: 223.642, printY: 126.48 };

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};

(async () => {
  await import("../lib/native").then((m) => m.initNative());

  const settings = {
    layerHeight: 0.1,
    hollow: false,
    wallMm: 2,
    holeDiaMm: 3,
    drainHoles: true,
    supports: true,
    supportRadiusMm: 1,
    supportTipMm: 0.5,
    supportMaxAngleDeg: 35,
    supportSpacingMm: 8,
    supportClearanceMm: 1,
    raft: true,
    raftLayers: 3,
    raftMarginMm: 5,
    aa: false,
  };

  // 1) normální pozice
  const mesh0 = makeTorus();
  const r0 = await runSlicePipeline(
    [{ positions: mesh0.positions, bounds: mesh0.bounds, triangleCount: mesh0.triangleCount, tx: 0, ty: 0 }],
    settings, PRINTER, { collectSupportMask: true }
  );
  let raft0 = 0;
  let sup0 = 0;
  for (let i = 0; i < Math.min(3, r0.result!.layers.length); i++) {
    for (const v of r0.result!.layers[i].data) if (v) raft0++;
  }
  for (const m of r0.supportMask ?? []) for (const v of m) sup0 += v;
  const area0 = mesh0.bounds.max[1] - mesh0.bounds.min[1]; // jen orientačně
  console.log(`normální: raft px (3 vrstvy) = ${raft0}, podpor px = ${sup0}`);

  // 2) otočeno o 90° kolem Y (stojí na hraně) — stejný scénář jako Rotate v UI
  const rotatedRaw = rotateMesh(makeTorus(), 0, 90, 0);
  const rotated = normalizeToPlate(rotatedRaw);
  console.log(`otočeno: bounds min=[${rotated.bounds.min.map((v)=>v.toFixed(1))}] max=[${rotated.bounds.max.map((v)=>v.toFixed(1))}]`);
  const r1 = await runSlicePipeline(
    [{ positions: rotated.positions, bounds: rotated.bounds, triangleCount: rotated.triangleCount, tx: 0, ty: 0 }],
    settings, PRINTER, { collectSupportMask: true }
  );
  let raft1 = 0;
  let sup1 = 0;
  for (let i = 0; i < Math.min(3, r1.result!.layers.length); i++) {
    for (const v of r1.result!.layers[i].data) if (v) raft1++;
  }
  for (const m of r1.supportMask ?? []) for (const v of m) sup1 += v;
  console.log(`otočený: raft px (3 vrstvy) = ${raft1}, podpor px = ${sup1}`);

  check("otočený model: raft existuje", raft1 > 10000, `${raft1} px`);
  check("otočený model: podpory existují", sup1 > 500, `${sup1} px`);
  // čistý model (bez podpor/raftu) pro porovnání překryvu
  const noSup = await runSlicePipeline(
    [{ positions: rotated.positions, bounds: rotated.bounds, triangleCount: rotated.triangleCount, tx: 0, ty: 0 }],
    { ...settings, supports: false, raft: false }, PRINTER
  );
  check("otočený model: žádný překryv podpor s modelem", (() => {
    let overlap = 0;
    const layers = noSup.result!.layers;
    // vrstvy raftu (0..2): raft pokrývá i spodek modelu — to je záměr
    for (let i = settings.raftLayers; i < (r1.supportMask ?? []).length; i++) {
      const m = r1.supportMask![i];
      for (let p = 0; p < m.length; p++) if (m[p] && layers[i].data[p]) overlap++;
    }
    return overlap === 0;
  })());

  console.log(fails === 0 ? "\nHOTOVO — vse proselo" : `\n${fails} NESHOD`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
