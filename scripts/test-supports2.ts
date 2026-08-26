import { runSlicePipeline } from "../lib/pipeline";
import { makeBox, makeTorus } from "../lib/demo";

const SETTINGS = {
  layerHeight: 0.1, hollow: false, wallMm: 2, holeDiaMm: 3, drainHoles: true,
  supports: true, supportRadiusMm: 1, supportTipMm: 0.5,
  raft: false, raftLayers: 3, raftMarginMm: 3, aa: false,
};
const PRINTER = { resX: 11520, resY: 5120, printX: 223.642, printY: 126.48 };

(async () => {
  // krychle — podpory musí být 0
  const box = makeBox(40, 60);
  const r1 = await runSlicePipeline(
    [{ positions: box.positions, bounds: box.bounds, triangleCount: box.triangleCount, tx: 0, ty: 0 }],
    SETTINGS, PRINTER
  );
  let sup1 = 0;
  for (const m of r1.supportMask ?? []) for (const v of m) sup1 += v;
  console.log(`krychle: podpor px = ${sup1} (ocekavany 0), vrstvy ${r1.result?.layers.length}`);

  // donut — podpory pod okrajem (> 0)
  const torus = makeTorus();
  const r2 = await runSlicePipeline(
    [{ positions: torus.positions, bounds: torus.bounds, triangleCount: torus.triangleCount, tx: 0, ty: 0 }],
    SETTINGS, PRINTER
  );
  let sup2 = 0;
  for (const m of r2.supportMask ?? []) for (const v of m) sup2 += v;
  console.log(`torus: podpor px = ${sup2} (ocekavany > 0), vrstvy ${r2.result?.layers.length}`);
})().catch((e) => { console.error("ERR:", e); process.exit(1); });
