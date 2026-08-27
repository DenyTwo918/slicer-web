import type { SliceResult } from "./slice";

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
 * Implementace: skutečná 3D box eroze solidního objemu. Pixel je vnitřek jen
 * když je celé XY okolí i všechny vrstvy v tloušťce stěny vyplněné. Tím se
 * stěna nerozpadá na šikmých plochách (původní kontrola pouhých 4 bodů v XY
 * a dvou vrstev v Z vytvářela díry a proměnlivou tloušťku). Odvodňovací otvory
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
  const out: Uint8Array[] = Array.from({ length: N });
  const holeBottom = opts.drainHoles ? Math.max(0, Math.floor(N * 0.05)) : -1;
  const holeTop = opts.drainHoles ? Math.max(0, Math.floor(N * 0.85)) : -1;

  // XY eroze jedné vrstvy přes integrální obraz: kontroluje celé okolí,
  // nikoli jen čtyři vzdálené vzorky. Každá vrstva se spočítá právě jednou.
  const integralStride = W + 1;
  const integral = new Uint32Array((W + 1) * (H + 1));
  const erodeXY = (src: Uint8Array) => {
    const dst = new Uint8Array(W * H);
    if (!hasPixels(src) || W <= wallPx * 2 || H <= wallPx * 2) return dst;
    for (let y = 0; y < H; y++) {
      let rowSum = 0;
      const srcRow = y * W;
      const dstRow = (y + 1) * integralStride;
      const prevRow = y * integralStride;
      for (let x = 0; x < W; x++) {
        rowSum += src[srcRow + x] ? 1 : 0;
        integral[dstRow + x + 1] = integral[prevRow + x + 1] + rowSum;
      }
    }
    const side = wallPx * 2 + 1;
    const area = side * side;
    for (let y = wallPx; y < H - wallPx; y++) {
      const y0 = y - wallPx;
      const y1 = y + wallPx + 1;
      const row = y * W;
      for (let x = wallPx; x < W - wallPx; x++) {
        if (!src[row + x]) continue;
        const x0 = x - wallPx;
        const x1 = x + wallPx + 1;
        const sum = integral[y1 * integralStride + x1] - integral[y0 * integralStride + x1]
          - integral[y1 * integralStride + x0] + integral[y0 * integralStride + x0];
        if (sum === area) dst[row + x] = 1;
      }
    }
    return dst;
  };

  // Posuvné Z okno drží jen 2*wallLayers+1 erodovaných vrstev. Je to přesná
  // separabilní 3D box eroze bez násobného skenování všech sousedních vrstev.
  const zCount = new Uint16Array(W * H);
  const cache = new Map<number, Uint8Array>();
  const addLayer = (index: number, delta: 1 | -1) => {
    if (index < 0 || index >= N) return;
    let eroded = cache.get(index);
    if (!eroded) {
      eroded = erodeXY(slice.layers[index].data);
      cache.set(index, eroded);
    }
    for (let p = 0; p < eroded.length; p++) if (eroded[p]) zCount[p] += delta;
  };
  for (let j = 0; j <= wallLayers && j < N; j++) addLayer(j, 1);
  const fullWindow = wallLayers * 2 + 1;

  for (let i = 0; i < N; i++) {
    const original = slice.layers[i].data;
    const layer = new Uint8Array(W * H);
    const completeZWindow = i >= wallLayers && i + wallLayers < N;
    for (let p = 0; p < layer.length; p++) {
      if (original[p] && (!completeZWindow || zCount[p] !== fullWindow)) layer[p] = 1;
    }
    if (i === holeBottom || i === holeTop) carveEdgeHole(layer, holeR, W, H);
    out[i] = layer;

    const leaving = i - wallLayers;
    addLayer(leaving, -1);
    cache.delete(leaving);
    addLayer(i + wallLayers + 1, 1);
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
