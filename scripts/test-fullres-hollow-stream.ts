import assert from "node:assert/strict";
import { createStreamingHollowRasterizer } from "../lib/fullRes";

const W = 13;
const H = 11;
const N = 9;
// XY a Z poloměr jsou záměrně různé: 12K tisk má typicky mnohem víc
// pixelů stěny než vrstev a řádkový ring se musí dimenzovat podle XY.
// 1 mm wall at 0.5 mm/px in X and 0.25 mm/px in Y.
const wallRadiusX = 2;
const wallRadiusY = 4;
const wallLayers = 1;

// Nepravidelný solidní objem: otvor v jedné vrstvě ověřuje, že se chyba
// front/back obálky nepromění ve falešné vnitřní jádro v okolních vrstvách.
const solid = Array.from({ length: N }, (_, z) => {
  const data = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) data[y * W + x] = 255;
  }
  if (z === 4) {
    for (let y = 4; y <= 6; y++) {
      for (let x = 5; x <= 7; x++) data[y * W + x] = 0;
    }
  }
  return data;
});

function expectedLayer(z: number) {
  const out = solid[z].slice();
  const completeZ = z >= wallLayers && z + wallLayers < N;
  if (!completeZ) return out;
  for (let y = wallRadiusY; y < H - wallRadiusY; y++) {
    for (let x = wallRadiusX; x < W - wallRadiusX; x++) {
      let core = true;
      for (let zz = z - wallLayers; zz <= z + wallLayers && core; zz++) {
        for (let yy = y - wallRadiusY; yy <= y + wallRadiusY && core; yy++) {
          for (let xx = x - wallRadiusX; xx <= x + wallRadiusX; xx++) {
            if (!solid[zz][yy * W + xx]) {
              core = false;
              break;
            }
          }
        }
      }
      if (core) out[y * W + x] = 0;
    }
  }
  return out;
}

let calls = 0;
let outputCalls = 0;
let coreContextCalls = 0;
const stream = createStreamingHollowRasterizer(
  (z) => {
    assert.equal(z, calls++, "rasterizér musí být volán sekvenčně právě jednou");
    const data = solid[z].slice();
    return { data, count: 0, minX: 0, minY: 0, maxX: W - 1, maxY: H - 1 };
  },
  W,
  H,
  N,
  wallRadiusX,
  wallRadiusY,
  wallLayers,
  (z, coreRuns, coreThreshold) => {
    assert.equal(z, outputCalls++, "výstupní rasterizér musí být volán sekvenčně právě jednou");
    const data = solid[z].slice();
    if (coreRuns) {
      coreContextCalls++;
      assert.notEqual(coreThreshold, undefined);
      for (let p = 0; p < data.length; p++) {
        if (coreRuns[p] >= coreThreshold!) data[p] = 0;
      }
    }
    let count = 0;
    for (const value of data) if (value) count++;
    return { data, count, minX: 0, minY: 0, maxX: W - 1, maxY: H - 1 };
  }
);

for (let z = 0; z < N; z++) {
  const actual = stream(z);
  assert.deepEqual(actual.data, expectedLayer(z), `3D hollow vrstva ${z}`);
  let count = 0;
  for (const value of actual.data) if (value) count++;
  assert.equal(actual.count, count, `počet pixelů vrstvy ${z}`);
}
assert.equal(calls, N, "každá solidní vrstva se rasterizuje pouze jednou");
assert.equal(outputCalls, N, "každá výstupní solidní vrstva se rasterizuje pouze jednou");
assert.equal(coreContextCalls, N - wallLayers * 2, "core se filtruje přímo při výstupní rasterizaci");

assert.throws(() => stream(N), /mimo rozsah/);
console.log("[OK] full-res streaming hollow odpovídá referenční 3D erozi");

// Produkční 12K tvar: samotný stream nesmí před prvním řezem alokovat tři
// byte-per-pixel scratch mapy (a už vůbec ne Z okno plných/packed vrstev).
// Limit ponechává prostor pro jednu byte mapu a Uint8 Z běhy: 2*n = 118 MiB.
const productionPixels = 11520 * 5120;
const before = process.memoryUsage().arrayBuffers;
const productionStream = createStreamingHollowRasterizer(
  () => { throw new Error("allocation benchmark nesmí rasterizovat"); },
  11520,
  5120,
  2000,
  20,
  40,
  40,
  () => { throw new Error("allocation benchmark nesmí materializovat"); }
);
const allocated = process.memoryUsage().arrayBuffers - before;
assert.ok(productionStream);
assert.ok(
  allocated <= productionPixels * 2 + 1024 * 1024,
  `12K hollow stream alokoval ${(allocated / 1024 / 1024).toFixed(1)} MiB před řezem`
);
console.log(`[OK] 12K hollow pracovní mapy ${(allocated / 1024 / 1024).toFixed(1)} MiB`);
