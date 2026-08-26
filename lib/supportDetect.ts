import type { PipelineModel } from "./pipeline";

/**
 * Detekce kotev podpor — převzato z mslicer (tools/src/supports/detect.rs):
 * overhanging_faces() s úhlovou detekcí z normál trojúhelníků.
 *
 * Na rozdíl od starého pixel-diff přístupu (šum ±1 px na stěnách → podpory
 * všude) se podpírá JEN plocha skloněná dolů víc než maxAngleDeg od svislice.
 * Svislé stěny (normála ~vodorovná) a horní plochy (normála nahoru) se
 * nepodpírají vůbec.
 *
 * Kotvy se deduplikují na pravidelné mřížce (spacingMm) — jako
 * face_support_spacing v mslicer; v každé buňce vyhraje nejnižší (nejkritičtější).
 */

export interface SupportAnchor {
  /** pixel v slicovacím rastru */
  x: number;
  y: number;
  /** index vrchní vrstvy sloupu (kotva pod spodní plochou modelu) */
  layer: number;
}

export interface AnchorOptions {
  /** max. úhel od svislice dolů (default 35°) — mírnější než mslicer 30° */
  maxAngleDeg?: number;
  /** min. rozestup kotev na desce v mm (default 8) */
  spacingMm?: number;
  /** min. výška kotvy nad deskou v mm — blíž k desce se nepodpírá (default 1) */
  clearanceMm?: number;
}

interface AnchorInternal extends SupportAnchor {
  zRel: number;
}

export function detectSupportAnchors(
  models: PipelineModel[],
  sliceInfo: {
    layerHeight: number;
    minZ: number;
    resX: number;
    resY: number;
    printX: number;
    printY: number;
  },
  opts?: AnchorOptions
): SupportAnchor[] {
  const fin = (v: number | undefined, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const maxAngle = ((fin(opts?.maxAngleDeg, 35)) * Math.PI) / 180;
  const spacingMm = fin(opts?.spacingMm, 8);
  const clearanceMm = fin(opts?.clearanceMm, 1);
  const { layerHeight, minZ, resX, resY, printX, printY } = sliceInfo;
  if (models.length === 0) return [];

  const pxPerMmX = resX / printX;
  const pxPerMmY = resY / printY;
  const spacingPxX = Math.max(1, spacingMm * pxPerMmX);
  const spacingPxY = Math.max(1, spacingMm * pxPerMmY);
  const gW = Math.ceil(resX / spacingPxX);
  const gH = Math.ceil(resY / spacingPxY);
  const best: (AnchorInternal | null)[] = new Array(gW * gH).fill(null);

  for (const m of models) {
    const centerX = (printX - (m.bounds.max[0] - m.bounds.min[0])) / 2 - m.bounds.min[0];
    const centerY = (printY - (m.bounds.max[1] - m.bounds.min[1])) / 2 - m.bounds.min[1];
    const pos = m.positions;

    for (let t = 0; t < m.triangleCount; t++) {
      const o = t * 9;
      const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
      const bx = pos[o + 3], by = pos[o + 4], bz = pos[o + 5];
      const cxx = pos[o + 6], cyy = pos[o + 7], czz = pos[o + 8];

      // normála z vrcholů (winding STL = ven z materiálu)
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cxx - ax, vy = cyy - ay, vz = czz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;

      // úhel od směru dolů: 0° = plocha směřuje přímo dolů (podhled), 90° = svislá stěna
      const angle = Math.acos(Math.min(1, Math.max(-1, -nz)));
      if (angle > maxAngle) continue;

      // centroid (světové souřadnice)
      const gx = (ax + bx + cxx) / 3;
      const gy = (ay + by + cyy) / 3;
      const gz = (az + bz + czz) / 3;
      const zRel = gz - minZ;
      // moc blízko desky → nepodpírat (most přes desku)
      if (zRel < clearanceMm) continue;

      const px = Math.floor((gx + centerX + m.tx) * pxPerMmX);
      const py = Math.floor((gy + centerY + m.ty) * pxPerMmY);
      if (px < 0 || py < 0 || px >= resX || py >= resY) continue;

      // vrchní vrstva sloupu = první vrstva UVNITŘ modelu nad spodní plochou
      // (špička se dotýká modelu; sloup klesá od vrstvy níž)
      const layer = Math.max(0, Math.ceil(zRel / layerHeight - 0.5));

      const cellX = Math.min(gW - 1, Math.floor(px / spacingPxX));
      const cellY = Math.min(gH - 1, Math.floor(py / spacingPxY));
      const gi = cellY * gW + cellX;
      const prev = best[gi];
      if (!prev || zRel < prev.zRel) {
        best[gi] = { x: px, y: py, layer, zRel };
      }
    }
  }

  return best.filter((a): a is AnchorInternal => !!a);
}
