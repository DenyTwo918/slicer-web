/**
 * Test nativních (WASM SIMD) kernelů: korektnost (vs JS reference) + benchmark.
 * Spuštění: npx tsx scripts/test-native.ts
 */
import { initNative, nativeReady, wasmDilate, wasmHollowShell, wasmAaBlur } from "../lib/native";

// --- JS reference implementace (kopie sémantiky z lib/*.ts) ---

function jsDilate(src: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!src[y * W + x]) continue;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(W - 1, x + r);
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(H - 1, y + r);
      for (let yy = y0; yy <= y1; yy++) out.fill(1, yy * W + x0, yy * W + x1 + 1);
    }
  }
  return out;
}

function jsHollow(src: Uint8Array, W: number, H: number, d: number): Uint8Array {
  const out = new Uint8Array(W * H);
  const isF = (x: number, y: number) => (x >= 0 && x < W && y >= 0 && y < H ? src[y * W + x] !== 0 : false);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (!src[p]) continue;
      if (
        isF(x + d, y) && isF(x - d, y) && isF(x, y + d) && isF(x, y - d)
      ) {
        out[p] = 0;
      } else {
        out[p] = src[p];
      }
    }
  }
  return out;
}

function jsAa(src: Uint8Array, W: number, H: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(H - 1, y + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(W - 1, x + 1);
      let sum = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * W;
        for (let xx = x0; xx <= x1; xx++) sum += src[row + xx];
      }
      out[y * W + x] = Math.round((sum / 9) * 255);
    }
  }
  return out;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function randomLayer(W: number, H: number, fill: number): Uint8Array {
  const a = new Uint8Array(W * H);
  for (let i = 0; i < a.length; i++) a[i] = Math.random() < fill ? 1 : 0;
  return a;
}

function bench(name: string, fn: () => void, runs = 5): number {
  fn(); // warmup
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  return (performance.now() - t0) / runs;
}

(async () => {
  await initNative();
  console.log("nativeReady:", nativeReady());
  if (!nativeReady()) {
    console.error("WASM se nenaloadoval — test končí.");
    process.exit(1);
  }

  const W = 720, H = 320, n = W * H;
  const dense = randomLayer(W, H, 0.25);
  const sparse = randomLayer(W, H, 0.03);

  let fails = 0;

  // --- korektnost ---
  for (const r of [1, 2, 8]) {
    const j = jsDilate(sparse, W, H, r);
    const w = wasmDilate(sparse, W, H, r);
    if (!same(j, w)) { console.error(`dilate r=${r}: NESHODA`); fails++; }
    else console.log(`dilate r=${r}: OK`);
  }
  for (const d of [1, 8, 20]) {
    const j = jsHollow(dense, W, H, d);
    const w = wasmHollowShell(dense, W, H, d);
    if (!same(j, w)) { console.error(`hollow d=${d}: NESHODA`); fails++; }
    else console.log(`hollow d=${d}: OK`);
  }
  {
    const j = jsAa(dense, W, H);
    const w = wasmAaBlur(dense, W, H);
    if (!same(j, w)) { console.error("aa_blur: NESHODA"); fails++; }
    else console.log("aa_blur: OK");
  }

  // --- benchmark ---
  console.log("\n--- benchmark (720×320, průměr 5 běhů) ---");
  const rows: [string, number, number][] = [];
  const tDilJs = bench("dilate r=8 (sparse)", () => jsDilate(sparse, W, H, 8));
  const tDilWa = bench("dilate r=8 (sparse)", () => wasmDilate(sparse, W, H, 8));
  rows.push(["dilate r=8 sparse", tDilJs, tDilWa]);
  const tDilJsD = bench("dilate r=8 (dense)", () => jsDilate(dense, W, H, 8));
  const tDilWaD = bench("dilate r=8 (dense)", () => wasmDilate(dense, W, H, 8));
  rows.push(["dilate r=8 dense", tDilJsD, tDilWaD]);
  const tHolJs = bench("hollow d=8", () => jsHollow(dense, W, H, 8));
  const tHolWa = bench("hollow d=8", () => wasmHollowShell(dense, W, H, 8));
  rows.push(["hollow d=8", tHolJs, tHolWa]);
  const tAaJs = bench("aa_blur", () => jsAa(dense, W, H));
  const tAaWa = bench("aa_blur", () => wasmAaBlur(dense, W, H));
  rows.push(["aa_blur", tAaJs, tAaWa]);

  for (const [name, jsMs, waMs] of rows) {
    console.log(
      `${name.padEnd(20)} JS ${jsMs.toFixed(2)} ms | WASM ${waMs.toFixed(2)} ms | x${(jsMs / Math.max(waMs, 0.001)).toFixed(1)}`
    );
  }

  if (fails > 0) {
    console.error(`\n${fails} NESHOD — TEST SELHAL`);
    process.exit(1);
  }
  console.log("\nHOTOVO — vse proselo");
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
