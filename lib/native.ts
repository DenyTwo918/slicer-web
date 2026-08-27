/**
 * Nativní kernely (WASM SIMD) pro pixelové operace sliceru.
 * Načte public/wasm/slice.wasm (9,6 KB, kompilováno zig cc -O3 -msimd128).
 * Pokud se nenačte (CSP, starý prohlížeč, offline), vrátí null
 * a volající použijí stávající JS implementace (fallback).
 *
 * Scratch paměť: sloty po n = W*H bytech: [0]=out, [1]=src, [2]=layer, [3]=mask, [4]=orig.
 */

let instance: WebAssembly.Instance | null = null;
let promise: Promise<WebAssembly.Instance | null> | null = null;

async function load(): Promise<WebAssembly.Instance | null> {
  try {
    let bytes: Uint8Array;
    if (typeof process !== "undefined" && process.versions?.node) {
      // Node (testy) — cesta z env, default repo root
      const fs = await import("node:fs");
      const p = process.env.NATIVE_WASM_PATH || "public/wasm/slice.wasm";
      bytes = fs.readFileSync(/* turbopackIgnore: true */ p);
    } else {
      const res = await fetch("/wasm/slice.wasm", { cache: "force-cache" });
      if (!res.ok) return null;
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    // Pozor: některá prostředí (Node, některé buildy) vrací { module, instance },
    // jiná (spec prohlížeče) rovnou Instance — podpora obou
    const r = (await WebAssembly.instantiate(bytes, {})) as
      | WebAssembly.Instance
      | { module: WebAssembly.Module; instance: WebAssembly.Instance };
    return "instance" in r ? r.instance : r;
  } catch {
    return null;
  }
}

/** Inicializace — zavolej jednou před použitím (await). Selhání = null. */
export function initNative(): Promise<void> {
  if (!promise) promise = load().then((i) => (instance = i));
  return promise.then(() => undefined);
}

/** True, pokud jsou WASM kernely k dispozici. */
export function nativeReady(): boolean {
  return instance !== null;
}

interface SliceWasmExports {
  dilate_box: (src: number, out: number, W: number, H: number, r: number) => void;
  hollow_shell: (src: number, out: number, W: number, H: number, d: number) => void;
  aa_blur: (src: number, out: number, W: number, H: number) => void;
  fill_circle: (layer: number, cx: number, cy: number, r: number, W: number, H: number) => void;
  fill_circle_if_empty: (
    layer: number, mask: number, orig: number,
    cx: number, cy: number, r: number, W: number, H: number
  ) => void;
  fill_span: (img: number, row: number, x0: number, x1: number, W: number) => void;
  fill_between: (front: number, back: number, out: number, z: number, wall: number, W: number, H: number) => void;
  fill_between16: (
    front: number, back: number, out: number,
    zq: number, wallq: number, W: number, H: number, stats: number
  ) => void;
  memory: WebAssembly.Memory;
}

function ex(): SliceWasmExports {
  return instance!.exports as unknown as SliceWasmExports;
}

function ensureMem(n: number): Uint8Array<ArrayBuffer> {
  const e = ex();
  const need = 5 * n;
  if (e.memory.buffer.byteLength < need) {
    const pages = Math.ceil((need - e.memory.buffer.byteLength) / 65536);
    e.memory.grow(pages);
  }
  return new Uint8Array(e.memory.buffer as ArrayBuffer);
}

const OUT = 0;
const SRC = 1;

/** Box dilate (2r+1)² — vrací nový rastr. */
export function wasmDilate(src: Uint8Array, W: number, H: number, r: number): Uint8Array<ArrayBuffer> {
  const n = W * H;
  const view = ensureMem(n);
  view.set(src, SRC * n);
  ex().dilate_box(SRC * n, OUT * n, W, H, r);
  return view.slice(0, n);
}

/** Hollow shell — vnitřek (4 směry do d) pryč; vrací nový rastr. */
export function wasmHollowShell(src: Uint8Array, W: number, H: number, d: number): Uint8Array<ArrayBuffer> {
  const n = W * H;
  const view = ensureMem(n);
  view.set(src, SRC * n);
  ex().hollow_shell(SRC * n, OUT * n, W, H, d);
  return view.slice(0, n);
}

/** AA 3×3 box blur binárního rastru → šedá 0..255; vrací nový rastr. */
export function wasmAaBlur(src: Uint8Array, W: number, H: number): Uint8Array<ArrayBuffer> {
  const n = W * H;
  const view = ensureMem(n);
  view.set(src, SRC * n);
  ex().aa_blur(SRC * n, OUT * n, W, H);
  return view.slice(0, n);
}

/* ------------------------------------------------------------------ */
/* Depth slicing (WebGPU): depth mapy zůstávají v wasm paměti rezidentně */
/* Region: base = 5*n; front (4n), back (4n), out (n) — mimo scratch 0..5n */
/* ------------------------------------------------------------------ */

let depthN = -1;

function depthOffsets(n: number): { front: number; back: number; out: number; need: number } {
  const base = 5 * n;
  return { front: base, back: base + 4 * n, out: base + 8 * n, need: base + 9 * n };
}

function ensureBytes(need: number): Uint8Array<ArrayBuffer> {
  const e = ex();
  if (e.memory.buffer.byteLength < need) {
    const pages = Math.ceil((need - e.memory.buffer.byteLength) / 65536);
    e.memory.grow(pages);
  }
  return new Uint8Array(e.memory.buffer as ArrayBuffer);
}

/** Nahraje front/back depth mapy (mm, Float32) do wasm paměti — zavolej jednou. */
export function uploadDepth(front: Float32Array, back: Float32Array, n: number): void {
  const { front: fOff, back: bOff, need } = depthOffsets(n);
  ensureBytes(need);
  const f32 = new Float32Array(ex().memory.buffer as ArrayBuffer);
  f32.set(front, fOff / 4);
  f32.set(back, bOff / 4);
  depthN = n;
}

/** Plnění vrstvy z nahraných depth map: solid = front + wall < z < back - wall. */
export function fillBetweenZ(z: number, wall: number, W: number, H: number): Uint8Array<ArrayBuffer> {
  const n = W * H;
  if (n !== depthN) throw new Error("fillBetweenZ: nahraj nejdřív uploadDepth");
  const { front, back, out, need } = depthOffsets(n);
  ensureBytes(need);
  const view = new Uint8Array(ex().memory.buffer as ArrayBuffer);
  ex().fill_between(front, back, out, z, wall, W, H);
  return view.slice(out, out + n);
}

/* ------------------------------------------------------------------ */
/* Full-res (12K): uint16 kvantizované depth mapy, rezidentní ve wasm  */
/* Region: base16 = 14*n (za scratchem 0..5n a float-depth 5n..14n):   */
/*   front (2n), back (2n), out (n), stats (64 B)                      */
/* Rasterizér zapisuje přímo do těchto views (žádná duplicitní kopie). */
/* ------------------------------------------------------------------ */

let fullN = -1;

function fullOffsets(n: number) {
  const base = 14 * n;
  return {
    front: base,
    back: base + 2 * n,
    out: base + 4 * n,
    stats: base + 5 * n,
    need: base + 5 * n + 64,
  };
}

/** Alokuje full-res depth region ve wasm paměti — rasterizér píše přímo do views. */
export function fullDepthRegion(
  n: number
): { front: Uint16Array<ArrayBuffer>; back: Uint16Array<ArrayBuffer> } {
  const off = fullOffsets(n);
  ensureBytes(off.need);
  const mem = ex().memory.buffer as ArrayBuffer;
  fullN = n;
  return {
    front: new Uint16Array(mem, off.front, n),
    back: new Uint16Array(mem, off.back, n),
  };
}

/**
 * Plnění full-res vrstvy z uint16 depth map.
 * Vrací VIEW do wasm paměti (platí do dalšího volání!) + statistiky.
 */
export function fillBetween16Z(
  zq: number,
  wallq: number,
  W: number,
  H: number
): { data: Uint8Array<ArrayBuffer>; count: number; minX: number; maxX: number; minY: number; maxY: number } {
  const n = W * H;
  if (n !== fullN) throw new Error("fillBetween16Z: region není alokovaný");
  const off = fullOffsets(n);
  ensureBytes(off.need);
  ex().fill_between16(off.front, off.back, off.out, zq, wallq, W, H, off.stats);
  const mem = ex().memory.buffer as ArrayBuffer;
  const data = new Uint8Array(mem, off.out, n);
  const s = new Int32Array(mem, off.stats, 5);
  return {
    data,
    count: s[0],
    minX: s[1],
    maxX: s[2],
    minY: s[3],
    maxY: s[4],
  };
}
