import type { SliceResult } from "./slice";

export interface IslandDetectionOptions {
  /** Nejmenší nalezená komponenta, která se má vrátit. */
  minPixels?: number;
  /** Hodnota pixelu považovaná za vytvrzený materiál (včetně). */
  threshold?: number;
  /** První vrstva leží na podložce, proto se standardně za island nepovažuje. */
  includeFirstLayer?: boolean;
}

export interface PixelBoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface PixelCentroid {
  x: number;
  y: number;
}

export interface LayerComponentFinding {
  /** Pozice vrstvy v poli SliceResult.layers. */
  layer: number;
  /** Původní identifikátor vrstvy z Layer.index. */
  layerIndex: number;
  z: number;
  pixelCount: number;
  bbox: PixelBoundingBox;
  centroid: PixelCentroid;
  /** Pixely komponenty, které se přesně překrývají s předchozí vrstvou. */
  previousOverlapPixels: number;
  /** Island nemá ani jeden pixel podepřený předchozí vrstvou. */
  unsupported: boolean;
}

export type IslandFinding = LayerComponentFinding & {
  unsupported: true;
  previousOverlapPixels: 0;
};

const NEIGHBOURS_8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
] as const;

function validateSlice(slice: SliceResult): void {
  const expected = slice.resolutionX * slice.resolutionY;
  if (!Number.isInteger(slice.resolutionX) || !Number.isInteger(slice.resolutionY)
    || slice.resolutionX <= 0 || slice.resolutionY <= 0) {
    throw new Error("Island detection requires a positive integer slice resolution");
  }
  for (let i = 0; i < slice.layers.length; i++) {
    if (slice.layers[i].data.length !== expected) {
      throw new Error(`Layer ${i} has ${slice.layers[i].data.length} pixels; expected ${expected}`);
    }
  }
}

/**
 * Rozdělí každou vrstvu na 8-connected komponenty a určí, zda se komponenta
 * alespoň jedním pixelem překrývá s bezprostředně předchozí vrstvou.
 *
 * Překryv je záměrně přesný (stejné X/Y): pouhý diagonální dotyk s pixelem
 * minulé vrstvy není nosná plocha. 8-connectivity se používá pouze ke spojení
 * pixelů uvnitř aktuální vrstvy, aby diagonální hrany nevytvářely falešné
 * mikroskopické komponenty.
 */
export function analyzeLayerComponents(
  slice: SliceResult,
  options: IslandDetectionOptions = {},
): LayerComponentFinding[] {
  validateSlice(slice);
  const width = slice.resolutionX;
  const height = slice.resolutionY;
  const threshold = Math.max(1, Math.min(255, Math.floor(options.threshold ?? 1)));
  const minPixels = Math.max(1, Math.floor(options.minPixels ?? 1));
  const findings: LayerComponentFinding[] = [];
  const visited = new Uint8Array(width * height);
  // Reuse přes všechny vrstvy: u 12K/preview rastrů by stovky velkých alokací
  // zbytečně zatěžovaly GC ve slicovacím workeru.
  const queue = new Int32Array(width * height);

  for (let layer = 0; layer < slice.layers.length; layer++) {
    if (layer === 0 && !options.includeFirstLayer) continue;
    const current = slice.layers[layer];
    const previous = layer > 0 ? slice.layers[layer - 1] : undefined;
    visited.fill(0);

    for (let seed = 0; seed < current.data.length; seed++) {
      if (visited[seed] || current.data[seed] < threshold) continue;

      visited[seed] = 1;
      queue[0] = seed;
      let head = 0;
      let tail = 1;
      let pixelCount = 0;
      let previousOverlapPixels = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;

      while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor(index / width);
        pixelCount++;
        sumX += x;
        sumY += y;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (previous && previous.data[index] >= threshold) previousOverlapPixels++;

        for (const [dx, dy] of NEIGHBOURS_8) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const next = ny * width + nx;
          if (visited[next] || current.data[next] < threshold) continue;
          visited[next] = 1;
          queue[tail++] = next;
        }
      }

      if (pixelCount < minPixels) continue;
      findings.push({
        layer,
        layerIndex: current.index,
        z: current.z,
        pixelCount,
        bbox: { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 },
        centroid: { x: sumX / pixelCount, y: sumY / pixelCount },
        previousOverlapPixels,
        unsupported: previousOverlapPixels === 0,
      });
    }
  }

  return findings;
}

/** Vrátí pouze zcela nové komponenty bez pixelového překryvu s minulou vrstvou. */
export function detectIslands(
  slice: SliceResult,
  options: IslandDetectionOptions = {},
): IslandFinding[] {
  return analyzeLayerComponents(slice, options).filter(
    (finding): finding is IslandFinding => finding.unsupported,
  );
}
