import type { SliceResult } from "./slice";
import { nativeReady, wasmHollowShell } from "./native";

export interface HollowOptions {
  enabled: boolean;
  /** tloušťka stěny v mm */
  wallMm: number;
  /** průměr odvodňovacích otvorů v mm */
  holeDiaMm: number;
  /** automatické odvodňovací otvory (spodní + horní) */
  drainHoles: boolean;
}

function hasPixels(layer: Uint8Array): boolean {
  for (let i = 0; i < layer.length; i++) if (layer[i]) return true;
  return false;
}

function carveCircle(layer: Uint8Array, cx: number, cy: number, r: number, W: number, H: number) {
  const r2 = r * r;
  const x0 = Math.max(0, cx - r);
  const x1 = Math.min(W - 1, cx + r);
  const y0 = Math.max(0, cy - r);
  const y1 = Math.min(H - 1, cy + r);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) layer[y * W + x] = 0;
    }
  }
}

/**
 * Hollowing (dutý model): odstraní vnitřek stěn o tloušťce wallMm.
 * Implementace: rychlá aproximace eroze — pixel zůstává, jen pokud jsou
 * pixely ve vzdálenosti wallPx (4 směry) vyplněné. Odvodňovací otvory
 * se vyříznou na spodní a horní vrstvě na pravém okraji modelu.
 */
export function applyHollow(
  slice: SliceResult,
  opts: HollowOptions,
  mmPerPx: { x: number; y: number }
): SliceResult {
  if (!opts.enabled) return slice;
  const W = slice.resolutionX;
  const H = slice.resolutionY;
  const px = Math.min(mmPerPx.x, mmPerPx.y);
  const wallPx = Math.max(1, Math.round(opts.wallMm / px));
  const wallLayers = Math.max(1, Math.ceil(opts.wallMm / slice.layerHeight));
  const holeR = Math.max(1, Math.round((opts.holeDiaMm / 2) / px));

  const N = slice.layers.length;
  const out = slice.layers.map((l) => new Uint8Array(l.data));

  // spodní vrstvy zůstanou plné (pevná základna — správně i pro tisk)
  const solidBaseLayers = Math.max(1, Math.floor(N * 0.02));
  const holeBottom = opts.drainHoles ? Math.max(0, Math.floor(N * 0.05)) : -1;
  const holeTop = opts.drainHoles ? Math.max(0, Math.floor(N * 0.85)) : -1;

  for (let i = 0; i < N; i++) {
    const originalLayer = slice.layers[i].data;
    let layer = out[i];
    // vrstva plná? (skip prázdné)
    if (!hasPixels(layer)) continue;

    // pevná základna — nehollowovat
    if (i < solidBaseLayers) {
      // odvodňovací otvory i tak vyříznout
      if (i === holeBottom || i === holeTop) {
        carveEdgeHole(layer, holeR, W, H);
      }
      continue;
    }

    // rychlá eroze: pixel zůstane, pokud okolí ve vzdálenosti wallPx je plné
    if (nativeReady() && wallPx >= 1) {
      layer = wasmHollowShell(layer, W, H, wallPx);
      out[i] = layer;
    } else {
      const keep = new Uint8Array(W * H);
      const isFilled = (x: number, y: number) => layer[y * W + x] !== 0;
      for (let y = wallPx; y < H - wallPx; y++) {
        const row = y * W;
        for (let x = wallPx; x < W - wallPx; x++) {
          const p = row + x;
          if (!layer[p]) continue;
          if (
            isFilled(x + wallPx, y) &&
            isFilled(x - wallPx, y) &&
            isFilled(x, y + wallPx) &&
            isFilled(x, y - wallPx)
          ) {
            keep[p] = 1;
          }
        }
      }
      // hollow: filled a NE vnitřek
      for (let p = 0; p < W * H; p++) {
        if (keep[p]) layer[p] = 0;
      }
    }

    // 2D eroze sama o sobě odstraní střechu a dno dutiny. Vnitřek smíme
    // vymazat jen tehdy, když je pixel hluboko uvnitř také v ose Z.
    const below = i - wallLayers;
    const above = i + wallLayers;
    for (let p = 0; p < W * H; p++) {
      if (!originalLayer[p] || layer[p]) continue;
      const zInterior =
        below >= 0 &&
        above < N &&
        slice.layers[below].data[p] !== 0 &&
        slice.layers[above].data[p] !== 0;
      if (!zInterior) layer[p] = originalLayer[p];
    }

    // odvodňovací otvory: vyříznout na okraji (pravý okraj vrstvy)
    if (i === holeBottom || i === holeTop) {
      carveEdgeHole(layer, holeR, W, H);
    }
  }

  return {
    ...slice,
    layers: out.map((data, index) => ({ index, z: slice.layers[index].z, data })),
  };
}

/** Vyřízne kruhový otvor na pravém okraji vrstvy (pro odvod pryskyřice). */
function carveEdgeHole(layer: Uint8Array, holeR: number, W: number, H: number) {
  let mx = -1;
  let my = -1;
  for (let y = 0; y < H; y++) {
    for (let x = W - 1; x >= 0; x--) {
      if (layer[y * W + x]) {
        if (x > mx) {
          mx = x;
          my = y;
        }
        break; // na tomto řádku jen pravý okraj
      }
    }
  }
  if (mx >= 0) carveCircle(layer, mx, my, holeR, W, H);
}
