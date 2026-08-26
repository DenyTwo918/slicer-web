/**
 * Test úhlové detekce podpor (mslicer core adaptovaný).
 * Krychle na desce → ŽÁDNÉ podpory (svislé stěny, dno na desce).
 * Torus → podpory jen pod spodní plochou (podhled), žádné na stěnách/vršku.
 * Spuštění: npx tsx scripts/test-supports.ts
 */
import { detectSupportAnchors } from "../lib/supportDetect";
import { generateSupports } from "../lib/supports";
import { sliceMesh } from "../lib/slice";
import { makeBox, makeTorus } from "../lib/demo";

const PRINTER = { resX: 11520, resY: 5120, printX: 223.642, printY: 126.48 };
const RES = { resX: 720, resY: 320 };

function sliceModel(mesh: ReturnType<typeof makeBox>) {
  return sliceMesh(mesh, {
    layerHeight: 0.1,
    resolutionX: RES.resX,
    resolutionY: RES.resY,
    plateW: PRINTER.printX,
    plateH: PRINTER.printY,
    offsetX: 0,
    offsetY: 0,
  });
}

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};

// 1) KRYCHLE — žádné podpory
{
  const mesh = makeBox(40, 60);
  const anchors = detectSupportAnchors(
    [{ positions: mesh.positions, bounds: mesh.bounds, triangleCount: mesh.triangleCount, tx: 0, ty: 0 }],
    { layerHeight: 0.1, minZ: mesh.bounds.min[2], ...RES, printX: PRINTER.printX, printY: PRINTER.printY }
  );
  check("krychle: 0 kotev (svislé stěny + dno na desce)", anchors.length === 0, `nalezeno ${anchors.length}`);
}

// 2) TORUS — podpory pod spodní plochou
{
  const mesh = makeTorus();
  const anchors = detectSupportAnchors(
    [{ positions: mesh.positions, bounds: mesh.bounds, triangleCount: mesh.triangleCount, tx: 0, ty: 0 }],
    { layerHeight: 0.1, minZ: mesh.bounds.min[2], ...RES, printX: PRINTER.printX, printY: PRINTER.printY }
  );
  console.log(`torus: ${anchors.length} kotev`);
  check("torus: jsou kotvy", anchors.length > 0);
  // kotvy musí být uvnitř rastru a pod modelem (ne na stěnách — ověř rozptylem)
  const inRaster = anchors.every((a) => a.x >= 0 && a.x < RES.resX && a.y >= 0 && a.y < RES.resY);
  check("torus: kotvy v rastru", inRaster);

  // sloupy: maska podpor se nesmí překrývat s modelem (fillCircleIfEmpty)
  const slice = sliceModel(mesh);
  const sr = generateSupports(
    slice,
    { enabled: true, radiusPx: 3, tipPx: 2 },
    anchors
  );
  const W = RES.resX;
  const orig = slice.layers.map((l) => l.data);
  let overlap = 0;
  for (let i = 0; i < sr.mask.length; i++) {
    const m = sr.mask[i];
    for (let p = 0; p < m.length; p++) if (m[p] && orig[i][p]) overlap++;
  }
  check("torus: maska podpor se nekryje s modelem", overlap === 0, `překryv ${overlap} px`);
}

// 3) TORUS se špatným otočením (na ležato) — 3D generuje kotvy jinde než na stěnách
{
  const mesh = makeTorus();
  // otočíme o 90° kolem X: torus stojí na hraně → velký podhled
  const pos = mesh.positions;
  for (let i = 0; i < pos.length; i += 3) {
    const y = pos[i + 1];
    const z = pos[i + 2];
    pos[i + 1] = -z;
    pos[i + 2] = y;
  }
  mesh.bounds.min = [mesh.bounds.min[0], mesh.bounds.min[2], mesh.bounds.min[1]];
  mesh.bounds.max = [mesh.bounds.max[0], mesh.bounds.max[2], mesh.bounds.max[1]];
  const anchors = detectSupportAnchors(
    [{ positions: mesh.positions, bounds: mesh.bounds, triangleCount: mesh.triangleCount, tx: 0, ty: 0 }],
    { layerHeight: 0.1, minZ: mesh.bounds.min[2], ...RES, printX: PRINTER.printX, printY: PRINTER.printY }
  );
  console.log(`torus na hraně: ${anchors.length} kotev`);
  check("torus na hraně: kotvy existují", anchors.length > 0);
}

console.log(fails === 0 ? "\nHOTOVO — vse proselo" : `\n${fails} NESHOD`);
process.exit(fails === 0 ? 0 : 1);
