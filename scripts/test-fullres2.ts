/**
 * End-to-end test: full-res export MUSÍ obsahovat raft i podpory.
 * Donut s podporami+raftem vs bez → vrstva 0 musí mít větší plochu (raft),
 * vyšší vrstva musí mít sloupy.
 * Spuštění: NODE_OPTIONS=--max-old-space-size=6144 npx tsx scripts/test-fullres2.ts
 */
import { buildPm7FullRes } from "../lib/fullRes";
import { initNative } from "../lib/native";
import { makeTorus } from "../lib/demo";
import { unzipSync } from "fflate";

const PRINTER = { resX: 11520, resY: 5120, printX: 223.642, printY: 126.48 };

function decodeRle4(data: Uint8Array): { total: number; white: number } {
  let i = 0;
  let total = 0;
  let white = 0;
  while (i < data.length) {
    const b = data[i];
    const color = b >> 4;
    let done: number;
    if (color === 0 || color === 0xf) {
      done = ((b & 0xf) << 8) | data[i + 1];
      i += 2;
    } else {
      done = b & 0xf;
      i += 1;
    }
    total += done;
    if (color === 0xf) white += done;
  }
  return { total, white };
}

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};

(async () => {
  await initNative();
  const mesh = makeTorus();
  const models = [
    { positions: mesh.positions, bounds: mesh.bounds, triangleCount: mesh.triangleCount, tx: 0, ty: 0 },
  ];
  const base = {
    layerHeight: 0.5,
    hollow: false,
    wallMm: 2,
    holeDiaMm: 3,
    drainHoles: true,
    supportRadiusMm: 1,
    supportTipMm: 0.5,
    supportMaxAngleDeg: 35,
    supportSpacingMm: 8,
    supportClearanceMm: 1,
    raftLayers: 3,
    raftMarginMm: 5,
    aa: false,
  };

  // bez podpor a raftu
  const off = await buildPm7FullRes(models, { ...base, supports: false, raft: false }, PRINTER as any, [{ bounds: mesh.bounds }], {});
  // s podporami a raftem
  const on = await buildPm7FullRes(models, { ...base, supports: true, raft: true }, PRINTER as any, [{ bounds: mesh.bounds }], {});

  const fOff = unzipSync(off.bytes);
  const fOn = unzipSync(on.bytes);

  // vrstva 0: s raftem musí být VĚTŠÍ než bez (raft = dilatovaný otisk)
  const l0off = decodeRle4(fOff["layer_images/layer_0.pw0Img"]);
  const l0on = decodeRle4(fOn["layer_images/layer_0.pw0Img"]);
  console.log(`vrstva 0: bez ${l0off.white} px, s raftem ${l0on.white} px`);
  check("vrstva 0: raft zvětšil plochu", l0on.white > l0off.white * 1.05, `+${(((l0on.white / l0off.white) - 1) * 100).toFixed(0)} %`);
  check("vrstva 0: native rozlišení", l0on.total === PRINTER.resX * PRINTER.resY);

  // vrstva 2: s podporami musí být víc bílých pixelů (sloupy pod okrajem)
  const midIdx = Math.min(2, Math.floor(off.layers / 2));
  const mOff = decodeRle4(fOff[`layer_images/layer_${midIdx}.pw0Img`]);
  const mOn = decodeRle4(fOn[`layer_images/layer_${midIdx}.pw0Img`]);
  console.log(`vrstva ${midIdx}: bez ${mOff.white} px, s podporami ${mOn.white} px`);
  check(`vrstva ${midIdx}: podpory přidaly pixely`, mOn.white > mOff.white, `+${mOn.white - mOff.white} px`);

  console.log(fails === 0 ? "\nHOTOVO — vse proselo" : `\n${fails} NESHOD`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL:", e.message ?? e);
  process.exit(1);
});
