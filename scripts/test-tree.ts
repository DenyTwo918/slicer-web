/**
 * Test příčných vzpěr (cross bracing): dva sloupy blízko sebe → mezi nimi
 * musí být tenké vzpěrné pixely v poloviční výšce.
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
    layers.push({ index: i, z: 0.05 + i * 0.1, data: new Uint8Array(W * H) });
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
  // dva sloupy 30 px (~9 mm) od sebe, oba vysoké
  const anchors = [
    { x: 300, y: 150, layer: 79 },
    { x: 330, y: 160, layer: 79 },
  ];
  const sr = generateSupports(slice, { enabled: true, radiusPx: 3, tipPx: 2 }, anchors);
  const orig = slice.layers.map((l) => l.data);

  // oba sloupy došly k desce
  let bothAtPlate = true;
  for (const a of anchors) {
    let found = false;
    for (let yy = a.y - 10; yy <= a.y + 10 && !found; yy++)
      for (let xx = a.x - 10; xx <= a.x + 10 && !found; xx++)
        if (sr.mask[0][yy * W + xx]) found = true;
    if (!found) bothAtPlate = false;
  }
  check("oba sloupy došly k desce", bothAtPlate);

  // vzpěra: v poloviční výšce (vrstva ~40) jsou pixely MEZI sloupy
  // (na přímce mezi (300,150) a (330,160))
  const mid = 40;
  const m = sr.mask[mid];
  let braced = false;
  for (let f = 15; f <= 85 && !braced; f += 1) {
    const xx = Math.round(300 + (330 - 300) * (f / 100));
    const yy = Math.round(150 + (160 - 150) * (f / 100));
    for (let dy = -4; dy <= 4 && !braced; dy++) {
      for (let dx = -4; dx <= 4 && !braced; dx++) {
        if (m[(yy + dy) * W + xx + dx]) braced = true;
      }
    }
  }
  check("vzpěra mezi sloupy existuje", braced);

  console.log(fails === 0 ? "\nHOTOVO — vse proselo" : `\n${fails} NESHOD`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
