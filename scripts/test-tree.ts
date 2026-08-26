/**
 * Test stromových podpor: 2 kotvy blízko sebe → nižší/boční sloup se spojí
 * s kmenem a NEDOJDE samostatně k desce. Úspora pryskyřice.
 * Spuštění: npx tsx scripts/test-tree.ts
 */
import { generateSupports } from "../lib/supports";
import type { SliceResult } from "../lib/slice";

const W = 720;
const H = 320;
const N = 120;

function buildSlice(): SliceResult {
  const layers = [];
  for (let i = 0; i < N; i++) {
    const data = new Uint8Array(W * H);
    // spodní blok: vrstvy 0..49, x 0..60, y 100..200
    if (i <= 49) {
      for (let y = 100; y <= 200; y++) {
        for (let x = 0; x <= 60; x++) data[y * W + x] = 1;
      }
    }
    // horní blok: vrstvy 80..119, x 30..120, y 100..200
    if (i >= 80) {
      for (let y = 100; y <= 200; y++) {
        for (let x = 30; x <= 120; x++) data[y * W + x] = 1;
      }
    }
    layers.push({ index: i, z: 0.05 + i * 0.1, data });
  }
  return { layers, layerHeight: 0.1, resolutionX: W, resolutionY: H, minX: 0, minY: 0 };
}

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};

(async () => {
  const slice = buildSlice();
  // A: kmen (volný pád k desce), B: blízko A → má se spojit s kmenem
  const anchors = [
    { x: 90, y: 150, layer: 79 }, // kmen — volný pád (x=90 > spodní blok 60)
    { x: 55, y: 120, layer: 79 }, // nad spodním blokem → sklání se ke kmeni a spojí se
  ];
  const sr = generateSupports(slice, { enabled: true, radiusPx: 3, tipPx: 2 }, anchors);
  const orig = slice.layers.map((l) => l.data);

  // 1) žádný překryv s modelem
  let overlap = 0;
  for (let i = 0; i < sr.mask.length; i++) {
    const m = sr.mask[i];
    for (let p = 0; p < m.length; p++) if (m[p] && orig[i][p]) overlap++;
  }
  check("maska podpor se nekryje s modelem", overlap === 0, `překryv ${overlap} px`);

  // 2) kmen (A) došel k desce
  let trunkAtPlate = false;
  for (let yy = 140; yy <= 160 && !trunkAtPlate; yy++)
    for (let xx = 80; xx <= 100 && !trunkAtPlate; xx++)
      if (sr.mask[0][yy * W + xx]) trunkAtPlate = true;
  check("kmen došel k desce", trunkAtPlate);

  // 3) boční sloup (B) se SPOJIL — u jeho kotvy není vlastní sloup u desky
  let sideAlone = false;
  for (let yy = Math.max(0, 120 - 12); yy <= Math.min(H - 1, 120 + 12) && !sideAlone; yy++)
    for (let xx = Math.max(0, 55 - 12); xx <= Math.min(W - 1, 55 + 12) && !sideAlone; xx++)
      if (sr.mask[0][yy * W + xx]) sideAlone = true;
  check("boční sloup se spojil se kmenem (není sám u desky)", !sideAlone);

  // 4) boční sloup je spojený — v poloviční výšce existuje most mezi nimi
  let connected = false;
  const mid = 40;
  for (let yy = 110; yy <= 165 && !connected; yy++) {
    for (let xx = 50; xx <= 100 && !connected; xx++) {
      if (sr.mask[mid][yy * W + xx]) connected = true;
    }
  }
  check("boční větev je spojená s kmenem (vrstva 40)", connected);

  console.log(fails === 0 ? "\nHOTOVO — vse proselo" : `\n${fails} NESHOD`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
