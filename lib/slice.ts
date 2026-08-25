import type { StlMesh } from "./stl";

export interface SliceOptions {
  /** Výška vrstvy v mm */
  layerHeight: number;
  /** Rozlišení obrázku vrstvy (px) */
  resolutionX: number;
  resolutionY: number;
  /** Velikost tiskové desky v mm — rastr = deska, model se vycentruje */
  plateW?: number;
  plateH?: number;
  /** Posun modelu po desce (mm), přičte se po vycentrování */
  offsetX?: number;
  offsetY?: number;
}

export interface Layer {
  index: number;
  /** Výška vrstvy v mm */
  z: number;
  /** Rastr vrstvy: resolutionY × resolutionX, 1 = pixel, 0 = prázdno */
  data: Uint8Array;
}

export interface SliceResult {
  layers: Layer[];
  layerHeight: number;
  resolutionX: number;
  resolutionY: number;
  minX: number;
  minY: number;
}

/**
 * Slicuje mesh na vrstvy — klasický přístup: protnutí trojúhelníků rovinou
 * Z, sesbírání segmentů a vyplnění rastru pravidlem even-odd (sudý-lichý).
 *
 * Poznámka: MVP verze, bez anti-aliasingu a bez konzervace hran přes vrcholy
 * ležící přesně v rovině (může vzniknout drobný šum u degenerovaných meshí).
 */
export function sliceMesh(mesh: StlMesh, opts: SliceOptions): SliceResult {
  const { min, max } = mesh.bounds;
  const height = Math.max(max[2] - min[2], 1e-6);
  const numLayers = Math.max(1, Math.floor(height / opts.layerHeight));
  // rastr = tisková deska; model vycentrovaný (pokud deska zadána, jinak = bounds modelu)
  const plateW = opts.plateW ?? Math.max(max[0] - min[0], 1e-6);
  const plateH = opts.plateH ?? Math.max(max[1] - min[1], 1e-6);
  const pxPerMmX = opts.resolutionX / plateW;
  const pxPerMmY = opts.resolutionY / plateH;
  const centerX = (plateW - (max[0] - min[0])) / 2 - min[0];
  const centerY = (plateH - (max[1] - min[1])) / 2 - min[1];
  const offsetX = centerX + (opts.offsetX ?? 0);
  const offsetY = centerY + (opts.offsetY ?? 0);

  const layers: Layer[] = [];
  const positions = mesh.positions;

  for (let li = 0; li < numLayers; li++) {
    const z = min[2] + (li + 0.5) * opts.layerHeight;

    // 1) segmenty v rovině XY (mm)
    const segs: number[][] = [];
    for (let t = 0; t < mesh.triangleCount; t++) {
      const o = t * 9;
      const v = [
        [positions[o], positions[o + 1], positions[o + 2]],
        [positions[o + 3], positions[o + 4], positions[o + 5]],
        [positions[o + 6], positions[o + 7], positions[o + 8]],
      ];
      const pts: number[][] = [];
      for (let e = 0; e < 3; e++) {
        const a = v[e];
        const b = v[(e + 1) % 3];
        const da = a[2] - z;
        const db = b[2] - z;
        if ((da < 0 && db >= 0) || (db < 0 && da >= 0)) {
          const t0 = da / (da - db);
          pts.push([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0]);
        }
      }
      if (pts.length >= 2) {
        segs.push([pts[0][0], pts[0][1], pts[1][0], pts[1][1]]);
      }
    }

    // 2) rasterizace even-odd po řádcích
    const resX = opts.resolutionX;
    const resY = opts.resolutionY;
    const crossings: number[][] = Array.from({ length: resY }, () => []);
    for (const s of segs) {
      let x1 = (s[0] + offsetX) * pxPerMmX;
      let y1 = (s[1] + offsetY) * pxPerMmY;
      let x2 = (s[2] + offsetX) * pxPerMmX;
      let y2 = (s[3] + offsetY) * pxPerMmY;
      if (y1 > y2) {
        const tx = x1; const ty = y1;
        x1 = x2; y1 = y2; x2 = tx; y2 = ty;
      }
      const yStart = Math.max(0, Math.floor(y1));
      const yEnd = Math.min(resY - 1, Math.floor(y2));
      for (let row = yStart; row <= yEnd; row++) {
        const yy = row + 0.5;
        if (yy < y1 || yy > y2) continue;
        const t = (yy - y1) / (y2 - y1);
        crossings[row].push(x1 + (x2 - x1) * t);
      }
    }

    const img = new Uint8Array(resX * resY);
    for (let row = 0; row < resY; row++) {
      const xs = crossings[row].sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, Math.ceil(xs[k]));
        const x1 = Math.min(resX - 1, Math.floor(xs[k + 1]));
        for (let x = x0; x <= x1; x++) img[row * resX + x] = 1;
      }
    }

    layers.push({ index: li, z, data: img });
  }

  return {
    layers,
    layerHeight: opts.layerHeight,
    resolutionX: opts.resolutionX,
    resolutionY: opts.resolutionY,
    minX: min[0],
    minY: min[1],
  };
}

/**
 * Sjednotí dva slice výsledky (batch — víc modelů na jedné desce).
 * Předpokládá stejné rozlišení a výšku vrstvy; sloučí rastry vrstvu po vrstvě.
 */
export function unionSlices(a: SliceResult, b: SliceResult): SliceResult {
  const count = Math.max(a.layers.length, b.layers.length);
  const layers = [];
  for (let i = 0; i < count; i++) {
    const la = a.layers[i];
    const lb = b.layers[i];
    const data = new Uint8Array(a.resolutionX * a.resolutionY);
    if (la) {
      for (let p = 0; p < data.length; p++) data[p] = la.data[p];
    }
    if (lb) {
      for (let p = 0; p < data.length; p++) {
        if (lb.data[p]) data[p] = 1;
      }
    }
    layers.push({
      index: i,
      z: (la ?? lb).z,
      data,
    });
  }
  return {
    layers,
    layerHeight: a.layerHeight,
    resolutionX: a.resolutionX,
    resolutionY: a.resolutionY,
    minX: a.minX,
    minY: a.minY,
  };
}
