/**
 * Test routingu podpor (PrusaSlicer-style úhyb sloupu) na syntetických vrstvách.
 * Police: spodní blok (vrstvy 0..49, x 0..60px), horní blok (vrstvy 80..119, x 30..120px).
 * Kotva pod horním blokem NAD spodním blokem → sloup se musí uklonit (x>63) a dojít k desce.
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
  // kotva pod horním blokem NAD spodním blokem — musí uhnout doprava (x > 63)
  const anchor = { x: 50, y: 150, layer: 79 };
  const sr = generateSupports(slice, { enabled: true, radiusPx: 3, tipPx: 2 }, [anchor]);
  const orig = slice.layers.map((l) => l.data);

  // 1) maska se nesmí překrývat s modelem
  let overlap = 0;
  for (let i = 0; i < sr.mask.length; i++) {
    const m = sr.mask[i];
    for (let p = 0; p < m.length; p++) if (m[p] && orig[i][p]) overlap++;
  }
  check("maska podpor se nekryje s modelem", overlap === 0, `překryv ${overlap} px`);

  // 2) sloup je SOUVISLÝ od vrstvy 79 dolů k 0
  let contiguous = true;
  for (let i = 0; i <= 79; i++) {
    let has = false;
    for (let p = 0; p < sr.mask[i].length; p++) {
      if (sr.mask[i][p]) { has = true; break; }
    }
    if (!has) { contiguous = false; console.log(`  chybí maska na vrstvě ${i}`); break; }
  }
  check("sloup je souvislý (vrstvy 79..0)", contiguous);

  // 3) sloup došel k desce — maska na vrstvě 0 poblíž kotvy (po úhybu)
  const m0 = sr.mask[0];
  let atPlate = false;
  for (let yy = 100; yy <= 200 && !atPlate; yy++) {
    for (let xx = 30; xx <= 130 && !atPlate; xx++) {
      if (m0[yy * W + xx]) atPlate = true;
    }
  }
  check("sloup došel k desce (vrstva 0)", atPlate);

  // 4) sloup se uhnul DOPRAVA (x > 63) — prošel kolem spodního bloku (jakýkoli řádek)
  const m30 = sr.mask[30];
  let detoured = false;
  for (let yy = 100; yy <= 200 && !detoured; yy++) {
    for (let xx = 64; xx <= 130 && !detoured; xx++) if (m30[yy * W + xx]) detoured = true;
  }
  check("sloup se uhnul kolem spodního bloku (x>63)", detoured);

  console.log(fails === 0 ? "\nHOTOVO — vse proselo" : `\n${fails} NESHOD`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
