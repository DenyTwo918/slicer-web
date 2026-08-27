import type { PipelineModel } from "./pipeline";
import type { PipelineSettings } from "./pipeline";
import type { PrinterProfile } from "./profiles";
import type { SliceResult } from "./slice";
import {
  initNative,
  nativeReady,
  fullDepthRegion,
  fillBetween16Z,
  wasmDilate,
} from "./native";
import { detectSupportAnchors } from "./supportDetect";
import {
  placeSupports,
  crossBraceLines,
  braceLineFree,
  type PillarCtx,
  type PlacedPillar,
  type BraceLine,
} from "./supports";
import {
  encodeLayerToMachineInternal,
  encodeSceneSlice,
  buildPwsp,
  buildLayersControllerFrom,
  buildPrintInfo,
  type SceneLayerInfo,
  type Pm7Options,
} from "./pm7";

/**
 * Full-res (12K) streaming export.
 *
 * Slicování náhledu běží na 1/16 rozlišení kvůli paměti (~550 MB). Pro skutečný
 * tisk ale chceme nativních 11520×5120 px. Postup:
 *  1) CPU rasterizace meshí do front/back depth map na plném rozlišení
 *     (uint16 kvantizace — 3,5 µm přesnosti), PŘÍMO do wasm paměti
 *  2) vrstva po vrstvě: fill_between16 (WASM) → bitmapa je VIEW do wasm paměti
 *     → podpory se dokreslí z tras → RLE4 stream (scale 1) → bitmapa zahodí
 *  3) paměť: konstantní ~300 MB bez ohledu na počet vrstev
 *
 * Omezení v1: AA se ve full-res nepoužívá (nativní pixely), podpory se routují
 * na slicovacím rozlišení a přenásobí (kompromis).
 */

export interface FullResResult {
  bytes: Uint8Array;
  layers: number;
}

interface DepthInfo {
  zMin: number;
  zRange: number;
  kScale: number;
}

/** CPU rasterizace meshí do uint16 depth map (přímo do wasm paměti). */
function rasterizeDepthFull(
  models: PipelineModel[],
  printer: PrinterProfile,
  layerHeight: number
): DepthInfo & { front: Uint16Array<ArrayBuffer>; back: Uint16Array<ArrayBuffer> } {
  const resX = printer.resX;
  const resY = printer.resY;
  const n = resX * resY;

  let zMin = Infinity;
  let zMax = -Infinity;
  for (const m of models) {
    zMin = Math.min(zMin, m.bounds.min[2]);
    zMax = Math.max(zMax, m.bounds.max[2]);
  }
  const zRange = Math.max(zMax - zMin, 1e-6);
  // kvantizace: 0..65535 přes výšku modelu (3,5 µm při 230 mm)
  const kScale = 65535 / zRange;

  const { front, back } = fullDepthRegion(n);
  front.fill(65535);
  back.fill(0);

  const pxPerMmX = resX / printer.printX;
  const pxPerMmY = resY / printer.printY;

  const edges = (
    ax: number, ay: number, bx: number, by: number, cx: number, cy: number
  ) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

  for (const m of models) {
    const centerX = (printer.printX - (m.bounds.max[0] - m.bounds.min[0])) / 2 - m.bounds.min[0];
    const centerY = (printer.printY - (m.bounds.max[1] - m.bounds.min[1])) / 2 - m.bounds.min[1];
    const ox = centerX + m.tx; // mm
    const oy = centerY + m.ty; // mm
    const pos = m.positions;

    for (let t = 0; t < m.triangleCount; t++) {
      const o = t * 9;
      const v: [number, number, number][] = [];
      for (let k = 0; k < 3; k++) {
        v.push([
          (pos[o + k * 3] + ox) * pxPerMmX,
          (pos[o + k * 3 + 1] + oy) * pxPerMmY,
          (pos[o + k * 3 + 2] - zMin) * kScale,
        ]);
      }
      const area = edges(v[0][0], v[0][1], v[1][0], v[1][1], v[2][0], v[2][1]);
      if (area === 0) continue;

      const x0 = Math.max(0, Math.floor(Math.min(v[0][0], v[1][0], v[2][0])));
      const x1 = Math.min(resX - 1, Math.ceil(Math.max(v[0][0], v[1][0], v[2][0])));
      const y0 = Math.max(0, Math.floor(Math.min(v[0][1], v[1][1], v[2][1])));
      const y1 = Math.min(resY - 1, Math.ceil(Math.max(v[0][1], v[1][1], v[2][1])));

      for (let py = y0; py <= y1; py++) {
        const cy2 = py + 0.5;
        for (let px = x0; px <= x1; px++) {
          const cx2 = px + 0.5;
          const w0 = edges(v[1][0], v[1][1], v[2][0], v[2][1], cx2, cy2);
          const w1 = edges(v[2][0], v[2][1], v[0][0], v[0][1], cx2, cy2);
          const w2 = edges(v[0][0], v[0][1], v[1][0], v[1][1], cx2, cy2);
          if (area > 0 ? (w0 >= 0 && w1 >= 0 && w2 >= 0) : (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
            const zq = ((w0 * v[0][2] + w1 * v[1][2] + w2 * v[2][2]) / area) | 0;
            const idx = py * resX + px;
            if (zq < front[idx]) front[idx] = zq;
            if (zq > back[idx]) back[idx] = zq;
          }
        }
      }
    }
  }

  return { zMin, zRange, kScale, front, back };
}

/** Sestaví full-res .pm7 (streaming po vrstvách). Běží ve workeru. */
export async function buildPm7FullRes(
  models: PipelineModel[],
  settings: PipelineSettings & { aa?: boolean },
  printer: PrinterProfile,
  meshes: { bounds: { min: [number, number, number]; max: [number, number, number] } }[],
  opts: Pm7Options & {
    previewSlice?: SliceResult | null;
    makePreview?: (slice: SliceResult, layerIdx: number, w: number, h: number) => Promise<Uint8Array>;
    onProgress?: (done: number, total: number) => void;
    previews?: [Uint8Array, Uint8Array] | null;
  } = {}
): Promise<FullResResult> {
  await initNative();
  if (!nativeReady()) throw new Error("Full-res export vyžaduje WASM.");

  if (models.length === 0) throw new Error("Žádný model k exportu.");
  if (settings.layerHeight <= 0) throw new Error("Neplatná výška vrstvy.");

  const resX = printer.resX;
  const resY = printer.resY;
  const n = resX * resY;

  let zMin = Infinity;
  let zMax = -Infinity;
  for (const m of models) {
    zMin = Math.min(zMin, m.bounds.min[2]);
    zMax = Math.max(zMax, m.bounds.max[2]);
  }
  const zRange = Math.max(zMax - zMin, 1e-6);
  const numLayers = Math.max(1, Math.floor(zRange / settings.layerHeight));
  const kScale = 65535 / zRange;

  // 1) rasterizace depth map (do wasm regionu)
  const depth = rasterizeDepthFull(models, printer, settings.layerHeight);

  // sanity check: aspoň nějaké platné pixely (jinak render selhal)
  let valid = 0;
  const step = 97; // prořezaný vzorek
  let sampled = 0;
  for (let i = 0; i < n; i += step) {
    sampled++;
    if (depth.front[i] < depth.back[i]) valid++;
  }
  if (valid < sampled * 0.001) {
    throw new Error("Full-res rasterizace neproběhla správně (prázdné depth mapy).");
  }

  // 2) podpory + raft na slicovacím rozlišení (downsampled depth z full-res).
  //    Jednotná logika s náhledem: stejné kotvy, stejný routing, stejný raft.
  const scale = resX % 16 === 0 ? 16 : resX % 8 === 0 ? 8 : 1;
  const sliceW = resX / scale;
  const sliceH = resY / scale;
  const pxPerMmSlice = printer.printX / sliceW;
  const sn = sliceW * sliceH;
  const sFront = new Uint16Array(sn);
  const sBack = new Uint16Array(sn);
  for (let y = 0; y < sliceH; y++) {
    const sy = Math.min(resY - 1, y * scale + (scale >> 1));
    for (let x = 0; x < sliceW; x++) {
      const sx = Math.min(resX - 1, x * scale + (scale >> 1));
      const si = y * sliceW + x;
      sFront[si] = depth.front[sy * resX + sx];
      sBack[si] = depth.back[sy * resX + sx];
    }
  }
  // kvantovaná výška vrstvy li — stejná kScale jako full-res (lineární v z)
  const layerZQ: number[] = [];
  for (let i = 0; i < numLayers; i++) layerZQ.push((0.05 + i * settings.layerHeight) * kScale);

  let placed: PlacedPillar[] = [];
  let braceLines: BraceLine[] = [];
  if (settings.supports) {
    const anchors = detectSupportAnchors(models, {
      layerHeight: settings.layerHeight,
      minZ: zMin,
      resX: sliceW,
      resY: sliceH,
      printX: printer.printX,
      printY: printer.printY,
    }, {
      maxAngleDeg: settings.supportMaxAngleDeg,
      spacingMm: settings.supportSpacingMm,
      clearanceMm: settings.supportClearanceMm,
    });
    const radiusPx = Math.max(2, Math.round(settings.supportRadiusMm / pxPerMmSlice));
    const tipPx = Math.max(1, Math.round(settings.supportTipMm / pxPerMmSlice));
    const frCtx: PillarCtx = {
      N: numLayers,
      modelAt: (li, x, y) => {
        const q = layerZQ[li];
        const i = y * sliceW + x;
        return sFront[i] < q && q < sBack[i];
      },
      fill: () => {},
    };
    // Chitubox model: jen kotvy s volnou svislou cestou (blokované se přeskočí)
    placed = placeSupports(
      anchors,
      frCtx,
      radiusPx,
      tipPx,
      sliceW,
      sliceH,
      undefined,
      Math.max(1, Math.round(2.5 / settings.layerHeight))
    );
    const maxXY = Math.max(8, Math.round(15 / pxPerMmSlice));
    const braceRSlice = Math.max(1, Math.round(0.5 / pxPerMmSlice));
    braceLines = crossBraceLines(placed, maxXY).filter((line) =>
      braceLineFree(frCtx, line, braceRSlice, sliceW, sliceH)
    );
  }

  const bottomExposure = opts.bottomExposure ?? 25;
  const normalExposure = opts.normalExposure ?? 2.5;
  const bottomLayers = opts.bottomLayers ?? 5;
  const layerTimes: number[] = [];
  for (let i = 0; i < numLayers; i++) layerTimes.push(i < bottomLayers ? bottomExposure : normalExposure);

  const pxMm = printer.printX / resX;
  const pyMm = printer.printY / resY;
  const hollowWallQ = settings.hollow ? settings.wallMm * kScale : 0;
  const solidBase = settings.hollow ? Math.max(1, Math.floor(numLayers * 0.02)) : 0;

  // odvodňovací otvory (full-res replikace carveEdgeHole z hollow.ts)
  const holeR =
    settings.hollow && settings.drainHoles
      ? Math.max(1, Math.round(settings.holeDiaMm / 2 / pxMm))
      : 0;
  const holeBottom = holeR > 0 ? Math.max(0, Math.floor(numLayers * 0.05)) : -1;
  const holeTop = holeR > 0 ? Math.max(0, Math.floor(numLayers * 0.85)) : -1;

  // sloupy podle vrstev — [vrstva] → seznam (x,y,r) ve full-res px
  const pxPerMmFull = printer.printX / resX;
  const radiusTopFull = Math.max(2, Math.round(settings.supportRadiusMm / pxPerMmFull));
  const tipFull = Math.max(1, Math.round(settings.supportTipMm / pxPerMmFull));
  const radiusBotFull = Math.round(radiusTopFull * 1.4);
  const pillarsByLayer: Map<number, { x: number; y: number; r: number }[]> = new Map();
  for (const p of placed) {
    // hlavní sloup od desky po začátek horního segmentu
    for (let li = 0; li <= p.top; li++) {
      const f = p.top > 0 ? 1 - li / p.top : 0;
      const r = Math.round(radiusTopFull + (radiusBotFull - radiusTopFull) * f);
      const arr = pillarsByLayer.get(li) ?? [];
      arr.push({ x: p.x * scale, y: p.y * scale, r });
      pillarsByLayer.set(li, arr);
    }
    // kuželový/šikmý top segment až ke skutečnému kontaktnímu bodu
    const span = Math.max(1, p.anchorLayer - p.top);
    for (let li = p.top + 1; li <= p.anchorLayer; li++) {
      const f = Math.min(1, Math.max(0, (li - p.top) / span));
      const arr = pillarsByLayer.get(li) ?? [];
      arr.push({
        x: Math.round((p.x + (p.anchorX - p.x) * f) * scale),
        y: Math.round((p.y + (p.anchorY - p.y) * f) * scale),
        r: Math.max(tipFull, Math.round(radiusTopFull + (tipFull - radiusTopFull) * f)),
      });
      pillarsByLayer.set(li, arr);
    }
  }

  // vzpěry — tenké čáry mezi sousedy (×scale)
  const braceR = Math.max(1, Math.round(0.5 / pxPerMmFull));
  const bracesByLayer: Map<number, { x: number; y: number; r: number }[]> = new Map();
  for (const L of braceLines) {
    const steps = Math.max(
      Math.abs(L.l2 - L.l1) * scale,
      Math.round(Math.hypot((L.x2 - L.x1) * scale, (L.y2 - L.y1) * scale)),
      1
    );
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const li = Math.round(L.l1 + (L.l2 - L.l1) * f);
      const cx = Math.round((L.x1 + (L.x2 - L.x1) * f) * scale);
      const cy = Math.round((L.y1 + (L.y2 - L.y1) * f) * scale);
      const arr = bracesByLayer.get(li) ?? [];
      arr.push({ x: cx, y: cy, r: braceR });
      bracesByLayer.set(li, arr);
    }
  }

  // Raft přímo v nativním rozlišení. Dřívější upscaling 1/16 masky dělal
  // viditelné 16×16 voxelové schody i v exportu.
  let raftIndices: Uint32Array | null = null;
  if (settings.raft && settings.raftLayers > 0) {
    const footprintFull = new Uint8Array(resX * resY);
    const zq0 = layerZQ[0];
    for (let idx = 0; idx < footprintFull.length; idx++) {
      if (depth.front[idx] < zq0 && zq0 < depth.back[idx]) footprintFull[idx] = 1;
    }
    const marginFull = Math.max(1, Math.round(settings.raftMarginMm / pxPerMmFull));
    const smoothRaft = wasmDilate(footprintFull, resX, resY, marginFull);
    let countRaft = 0;
    for (let idx = 0; idx < smoothRaft.length; idx++) countRaft += smoothRaft[idx] ? 1 : 0;
    raftIndices = new Uint32Array(countRaft);
    let ri = 0;
    for (let idx = 0; idx < smoothRaft.length; idx++) {
      if (smoothRaft[idx]) raftIndices[ri++] = idx;
    }
  }

  const machine = printer;
  const layerInfo: SceneLayerInfo[] = [];
  const files: Record<string, Uint8Array> = {};
  const union = meshes.length
    ? {
        min: [
          Math.min(...meshes.map((m) => m.bounds.min[0])),
          Math.min(...meshes.map((m) => m.bounds.min[1])),
          Math.min(...meshes.map((m) => m.bounds.min[2])),
        ] as [number, number, number],
        max: [
          Math.max(...meshes.map((m) => m.bounds.max[0])),
          Math.max(...meshes.map((m) => m.bounds.max[1])),
          Math.max(...meshes.map((m) => m.bounds.max[2])),
        ] as [number, number, number],
      }
    : { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] };

  for (let i = 0; i < numLayers; i++) {
    const zRel = 0.05 + i * settings.layerHeight;
    const zq = zRel * kScale;
    const wallq = i < solidBase ? 0 : hollowWallQ;
    const res = fillBetween16Z(zq, wallq, resX, resY);

    let count = res.count;
    let minX = res.minX;
    let maxX = res.maxX;
    let minY = res.minY;
    let maxY = res.maxY;

    // podpory z tras (kruhy, přeskočit pixely modelu)
    const pil = pillarsByLayer.get(i);
    if (pil) {
      for (const c of pil) {
        const r2 = c.r * c.r;
        const x0 = Math.max(0, c.x - c.r);
        const x1 = Math.min(resX - 1, c.x + c.r);
        const y0 = Math.max(0, c.y - c.r);
        const y1 = Math.min(resY - 1, c.y + c.r);
        for (let yy = y0; yy <= y1; yy++) {
          const rowF = yy * resX;
          for (let xx = x0; xx <= x1; xx++) {
            const idx = rowF + xx;
            if (res.data[idx]) continue; // model má přednost
            const dx = xx - c.x;
            const dy = yy - c.y;
            if (dx * dx + dy * dy <= r2 && !(depth.front[idx] < zq && zq < depth.back[idx])) {
              res.data[idx] = 255;
              count++;
            }
          }
        }
      }
    }

    // příčné vzpěry (tenké čáry mezi sloupy)
    const br = bracesByLayer.get(i);
    if (br) {
      for (const c of br) {
        const r2 = c.r * c.r;
        const x0 = Math.max(0, c.x - c.r);
        const x1 = Math.min(resX - 1, c.x + c.r);
        const y0 = Math.max(0, c.y - c.r);
        const y1 = Math.min(resY - 1, c.y + c.r);
        for (let yy = y0; yy <= y1; yy++) {
          const rowF = yy * resX;
          for (let xx = x0; xx <= x1; xx++) {
            const idx = rowF + xx;
            if (res.data[idx]) continue;
            const dx = xx - c.x;
            const dy = yy - c.y;
            if (dx * dx + dy * dy <= r2 && !(depth.front[idx] < zq && zq < depth.back[idx])) {
              res.data[idx] = 255;
              count++;
            }
          }
        }
      }
    }

    // raft (prvních N vrstev)
    if (raftIndices && i < Math.min(settings.raftLayers, numLayers)) {
      for (let k = 0; k < raftIndices.length; k++) {
        const idx = raftIndices[k];
        if (!res.data[idx] && !(depth.front[idx] < zq && zq < depth.back[idx])) {
          res.data[idx] = 255;
          count++;
        }
      }
    }

    // odvodňovací otvory — najdi pravý okraj a vyřízni kruh
    if (i === holeBottom || i === holeTop) {
      if (count > 0 || maxX >= 0) {
        let mx = -1;
        let my = -1;
        for (let yy = 0; yy < resY; yy++) {
          for (let xx = resX - 1; xx >= 0; xx--) {
            if (res.data[yy * resX + xx]) {
              if (xx > mx) {
                mx = xx;
                my = yy;
              }
              break;
            }
          }
        }
        if (mx >= 0) {
          const r2 = holeR * holeR;
          const x0 = Math.max(0, mx - holeR);
          const x1 = Math.min(resX - 1, mx + holeR);
          const y0 = Math.max(0, my - holeR);
          const y1 = Math.min(resY - 1, my + holeR);
          for (let yy = y0; yy <= y1; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
              const ddx = xx - mx;
              const ddy = yy - my;
              if (ddx * ddx + ddy * ddy <= r2) res.data[yy * resX + xx] = 0;
            }
          }
          count = Math.max(0, count - Math.round(Math.PI * holeR * holeR * 0.5));
        }
      }
    }

    const areaMm2 = count * pxMm * pyMm;
    layerInfo.push({
      z: zRel,
      areaMm2,
      x0: count === 0 ? 0 : minX * pxMm,
      y0: count === 0 ? 0 : minY * pyMm,
      x1: count === 0 ? 0 : (maxX + 1) * pxMm,
      y1: count === 0 ? 0 : (maxY + 1) * pyMm,
    });

    files[`layer_images/layer_${i}.pw0Img`] = encodeLayerToMachineInternal(
      res.data,
      resX,
      resY,
      machine
    );

    if (opts.onProgress && (i % 50 === 0 || i === numLayers - 1)) {
      opts.onProgress(i + 1, numLayers);
    }
  }

  // preview — z náhledového slicu (pokud je), jinak placeholder
  let previews: Uint8Array[];
  if (opts.previewSlice && opts.makePreview) {
    const mid = Math.floor(opts.previewSlice.layers.length / 2);
    previews = await Promise.all([
      opts.makePreview(opts.previewSlice, 0, 224, 168),
      opts.makePreview(opts.previewSlice, Math.max(1, mid), 224, 168),
    ]);
  } else {
    // placeholder 1×1 PNG (dekódování base64 bez Buffer závislosti)
    const b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const bin = atob(b64);
    const ph = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) ph[i] = bin.charCodeAt(i);
    previews = [ph, ph];
  }

  const volumeMl = 0; // full-res: objem počítán z náhledu (preview UI ho zobrazuje)
  const printTimeS = opts.printTimeS ?? Math.round(numLayers * 10);

  files["anycubic_photon_resins.pwsp"] = new TextEncoder().encode(
    JSON.stringify(buildPwsp(machine), null, 4)
  );
  files["layers_controller.conf"] = new TextEncoder().encode(
    JSON.stringify(buildLayersControllerFrom(numLayers, settings.layerHeight, layerTimes, {
      zupHeightBottom: opts.zupHeightBottom ?? 1.5,
      zupSpeedBottom: opts.zupSpeedBottom ?? 0.5,
      zupHeight: opts.zupHeight ?? 1.0,
      zupSpeed: opts.zupSpeed ?? 1.0,
    }), null, 4)
  );
  files["print_info.json"] = new TextEncoder().encode(
    JSON.stringify(buildPrintInfo(volumeMl, printTimeS))
  );
  files["software_info.conf"] = new TextEncoder().encode(
    JSON.stringify(
      { mark: "CHITUBOX", opengl: "3.3-CoreProfile", os: "win-64", version: "1.2.3" },
      null,
      4
    )
  );
  files["scene.slice"] = encodeSceneSlice(
    { layerCount: numLayers, bounds: union, layers: layerInfo },
    machine
  );
  files["preview_images/preview_0.png"] = previews[0];
  files["preview_images/preview_1.png"] = previews[1];

  const { zipSync, strToU8 } = await import("fflate");
  return {
    bytes: zipSync(files as unknown as Record<string, Uint8Array<ArrayBuffer>>),
    layers: numLayers,
  };
}
