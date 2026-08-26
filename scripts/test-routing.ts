/**
 * Test SLA podpor (Chitubox model): svislé sloupy + kolizní kontrola + vzpěry.
 * Spuštění: npx tsx scripts/test-routing.ts
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
  // A: volná cesta k desce (x=90 > spodní blok) — musí dostat sloup
  // B: cesta blokovaná spodním blokem (x=50 < 63) — musí být PŘESKOČENA
  const anchors = [
    { x: 90, y: 150, layer: 79 },
    { x: 50, y: 150, layer: 79 },
  ];
  const sr = generateSupports(slice, { enabled: true, radiusPx: 3, tipPx: 2 }, anchors);
  const orig = slice.layers.map((l) => l.data);

  // 1) maska se nesmí překrývat s modelem
  let overlap = 0;
  for (let i = 0; i < sr.mask.length; i++) {
    const m = sr.mask[i];
    for (let p = 0; p < m.length; p++) if (m[p] && orig[i][p]) overlap++;
  }
  check("maska podpor se nekryje s modelem", overlap === 0, `překryv ${overlap} px`);

  // 2) volný anchor má sloup až do vrstvy 0
  let aAtPlate = false;
  for (let yy = 140; yy <= 160 && !aAtPlate; yy++)
    for (let xx = 80; xx <= 100 && !aAtPlate; xx++)
      if (sr.mask[0][yy * W + xx]) aAtPlate = true;
  check("volný sloup došel k desce", aAtPlate);

  // 3) blokovaný anchor byl přeskočen — žádné podpory v jeho okolí u desky
  let bAlone = false;
  for (let yy = Math.max(0, 150 - 12); yy <= Math.min(H - 1, 150 + 12) && !bAlone; yy++)
    for (let xx = Math.max(0, 50 - 12); xx <= Math.min(W - 1, 50 + 12) && !bAlone; xx++)
      if (sr.mask[0][yy * W + xx]) bAlone = true;
  check("blokovaný anchor přeskočen (není u desky)", !bAlone);

  console.log(fails === 0 ? "\nHOTOVO — vse proselo" : `\n${fails} NESHOD`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
