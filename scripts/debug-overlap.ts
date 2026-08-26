import { runSlicePipeline } from "../lib/pipeline";
import { makeTorus } from "../lib/demo";
import { rotateMesh, normalizeToPlate } from "../lib/transform";

const PRINTER = { resX: 11520, resY: 5120, printX: 223.642, printY: 126.48 };

(async () => {
  await import("../lib/native").then((m) => m.initNative());
  const settings = {
    layerHeight: 0.1, hollow: false, wallMm: 2, holeDiaMm: 3, drainHoles: true,
    supports: true, supportRadiusMm: 1, supportTipMm: 0.5,
    supportMaxAngleDeg: 35, supportSpacingMm: 8, supportClearanceMm: 1,
    raft: true, raftLayers: 3, raftMarginMm: 5, aa: false,
  };
  const rotatedRaw = rotateMesh(makeTorus(), 0, 90, 0);
  const rotated = normalizeToPlate(rotatedRaw);
  const r1 = await runSlicePipeline(
    [{ positions: rotated.positions, bounds: rotated.bounds, triangleCount: rotated.triangleCount, tx: 0, ty: 0 }],
    settings, PRINTER
  );
  const W = 720;
  const noSup = await runSlicePipeline(
    [{ positions: rotated.positions, bounds: rotated.bounds, triangleCount: rotated.triangleCount, tx: 0, ty: 0 }],
    { ...settings, supports: false, raft: false }, PRINTER
  );
  const layers = noSup.result!.layers;
  let shown = 0;
  for (let i = 3; i < (r1.supportMask ?? []).length && shown < 10; i++) {
    const m = r1.supportMask![i];
    for (let p = 0; p < m.length && shown < 10; p++) {
      if (m[p] && layers[i].data[p]) {
        // je to model nebo podpora ve vrstvě?
        console.log(`overlap: vrstva ${i} (z=${layers[i].z.toFixed(2)}), px (${p % W},${Math.floor(p / W)})`);
        shown++;
      }
    }
  }
  console.log("hotovo");
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
