/**
 * CPU simulace GPU depth slicingu (stejná matematika jako lib/gpuSlice.ts)
 * → porovnání se sliceMesh. Ověřuje: bake offsetů, y-flip, normalizaci Z,
 * podmínku fill_between, počty vrstev.
 * Spuštění: npx tsx scripts/test-gpu-sim.ts
 */
import { sliceMesh } from "../lib/slice";
import { makeBox, makeTorus } from "../lib/demo";

const PRINTER = { resX: 11520, resY: 5120, printX: 223.642, printY: 126.48 };

function simulateGpu(models: { positions: Float32Array; bounds: any; triangleCount: number; tx: number; ty: number }[], layerHeight: number) {
  const scale = 16;
  const W = PRINTER.resX / scale;
  const H = PRINTER.resY / scale;
  const pxPerMmX = W / PRINTER.printX;
  const pxPerMmY = H / PRINTER.printY;
  let zMin = Infinity, zMax = -Infinity;
  for (const m of models) { zMin = Math.min(zMin, m.bounds.min[2]); zMax = Math.max(zMax, m.bounds.max[2]); }
  const zRange = Math.max(zMax - zMin, 1e-6);
  const numLayers = Math.max(1, Math.floor(zRange / layerHeight));
  const n = W * H;

  // front = min zN, back = max zN (per pixel) — jako depth test less/greater
  const front = new Float32Array(n).fill(1);
  const back = new Float32Array(n).fill(0);

  const edges = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

  for (const m of models) {
    const cx = (PRINTER.printX - (m.bounds.max[0] - m.bounds.min[0])) / 2 - m.bounds.min[0];
    const cy = (PRINTER.printY - (m.bounds.max[1] - m.bounds.min[1])) / 2 - m.bounds.min[1];
    const ox = cx + m.tx; // mm
    const oy = cy + m.ty; // mm
    const pos = m.positions;
    for (let t = 0; t < m.triangleCount; t++) {
      const o = t * 9;
      const v = [];
      for (let k = 0; k < 3; k++) {
        v.push([(pos[o + k * 3] + ox) * pxPerMmX, (pos[o + k * 3 + 1] + oy) * pxPerMmY, (pos[o + k * 3 + 2] - zMin) / zRange]);
      }
      // bbox
      const x0 = Math.max(0, Math.floor(Math.min(v[0][0], v[1][0], v[2][0])));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(v[0][0], v[1][0], v[2][0])));
      const y0 = Math.max(0, Math.floor(Math.min(v[0][1], v[1][1], v[2][1])));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(v[0][1], v[1][1], v[2][1])));
      const area = edges(v[0][0], v[0][1], v[1][0], v[1][1], v[2][0], v[2][1]);
      if (area === 0) continue;
      for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
          const cx2 = px + 0.5, cy2 = py + 0.5;
          const w0 = edges(v[1][0], v[1][1], v[2][0], v[2][1], cx2, cy2);
          const w1 = edges(v[2][0], v[2][1], v[0][0], v[0][1], cx2, cy2);
          const w2 = edges(v[0][0], v[0][1], v[1][0], v[1][1], cx2, cy2);
          if (area > 0 ? (w0 >= 0 && w1 >= 0 && w2 >= 0) : (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
            const z = (w0 * v[0][2] + w1 * v[1][2] + w2 * v[2][2]) / area;
            const idx = py * W + px;
            if (z < front[idx]) front[idx] = z;
            if (z > back[idx]) back[idx] = z;
          }
        }
      }
    }
  }

  // mm konverze (jako readback)
  for (let i = 0; i < n; i++) { front[i] = zMin + front[i] * zRange; back[i] = zMin + back[i] * zRange; }

  // fill vrstev (stejná podmínka jako fill_between)
  const layers: Uint8Array[] = [];
  for (let i = 0; i < numLayers; i++) {
    const z = zMin + (i + 0.5) * layerHeight;
    const out = new Uint8Array(n);
    for (let p = 0; p < n; p++) if (front[p] < z && z < back[p]) out[p] = 1;
    layers.push(out);
  }
  return { layers, W, H, numLayers };
}

function count(a: Uint8Array) { let c = 0; for (let i = 0; i < a.length; i++) c += a[i] ? 1 : 0; return c; }

(async () => {
  const tests = [
    { name: "krychle 40x40x60", mesh: makeBox(40, 60), tx: 0, ty: 0 },
    { name: "torus (donut)", mesh: makeTorus(), tx: 0, ty: 0 },
    { name: "krychle posunuta", mesh: makeBox(40, 60), tx: 30, ty: -20 },
  ];
  let fails = 0;
  for (const t of tests) {
    const m = t.mesh;
    const model = { positions: m.positions, bounds: m.bounds, triangleCount: m.triangleCount, tx: t.tx, ty: t.ty };
    const sim = simulateGpu([model], 0.1);
    const cpu = sliceMesh(m, {
      layerHeight: 0.1, resolutionX: sim.W, resolutionY: sim.H,
      plateW: PRINTER.printX, plateH: PRINTER.printY, offsetX: t.tx, offsetY: t.ty,
    });
    const n = sim.W * sim.H;
    let totalDiff = 0, totalSim = 0;
    const L = Math.min(sim.numLayers, cpu.layers.length);
    const sampleCounts: [number, number][] = [];
    for (let i = 0; i < L; i++) {
      const a = sim.layers[i], b = cpu.layers[i].data;
      for (let p = 0; p < n; p++) { if (a[p] !== b[p]) totalDiff++; }
      if (i === 0 || i === Math.floor(L / 2) || i === L - 1) sampleCounts.push([count(a), count(b)]);
      totalSim += count(a);
    }
    const layersOk = sim.numLayers === cpu.layers.length;
    const ratio = totalDiff / Math.max(totalSim, 1);
    const ok = layersOk && ratio < 0.03; // < 3 % rozdílných pixelů (hrany ±1 px, konvence vzorkování)
    console.log(`${t.name}: vrstvy ${sim.numLayers} vs ${cpu.layers.length} (${layersOk ? "OK" : "X"}) | rozdílných ${totalDiff} (${(ratio * 100).toFixed(3)} %) | vzorky ${JSON.stringify(sampleCounts)} → ${ok ? "✓" : "✗"}`);
    if (!ok) fails++;
  }
  console.log(fails === 0 ? "\nHOTOVO — vse proselo" : `\n${fails} NESHOD`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
