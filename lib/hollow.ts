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

function carveEllipse(layer: Uint8Array, cx: number, cy: number, rx: number, ry: number, W: number, H: number) {
  const x0 = Math.max(0, cx - rx);
  const x1 = Math.min(W - 1, cx + rx);
  const y0 = Math.max(0, cy - ry);
  const y1 = Math.min(H - 1, cy + ry);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) layer[y * W + x] = 0;
    }
  }
}

export interface DrainAnchor {
  x: number;
  y: number;
  layer: number;
  direction: "bottom" | "top";
}

interface CavityEdgeRun {
  x0: number;
  x1: number;
  y: number;
}

interface CavityEdge {
  layer: number;
  runs: CavityEdgeRun[];
}

interface CavityComponent {
  parent: CavityComponent;
  size: number;
  bottom: CavityEdge;
  top: CavityEdge;
}

interface CavityRun {
  x0: number;
  x1: number;
  component: CavityComponent;
}

function cavityRoot(component: CavityComponent): CavityComponent {
  let root = component;
  while (root.parent !== root) root = root.parent;
  while (component.parent !== component) {
    const parent = component.parent;
    component.parent = root;
    component = parent;
  }
  return root;
}

function mergeEdgeRuns(a: CavityEdge, b: CavityEdge): CavityEdge {
  for (const run of b.runs) a.runs.push(run);
  return a;
}

function betterBottom(a: CavityEdge, b: CavityEdge): CavityEdge {
  if (a.layer !== b.layer) return a.layer < b.layer ? a : b;
  return mergeEdgeRuns(a, b);
}

function betterTop(a: CavityEdge, b: CavityEdge): CavityEdge {
  if (a.layer !== b.layer) return a.layer > b.layer ? a : b;
  return mergeEdgeRuns(a, b);
}

function joinCavities(a: CavityComponent, b: CavityComponent): CavityComponent {
  a = cavityRoot(a);
  b = cavityRoot(b);
  if (a === b) return a;
  if (a.size < b.size) [a, b] = [b, a];
  b.parent = a;
  a.size += b.size;
  a.bottom = betterBottom(a.bottom, b.bottom);
  a.top = betterTop(a.top, b.top);
  return a;
}

function connectOverlapping(run: CavityRun, neighbours: CavityRun[]): void {
  for (const neighbour of neighbours) {
    if (neighbour.x1 < run.x0) continue;
    if (neighbour.x0 > run.x1) break;
    run.component = joinCavities(run.component, neighbour.component);
  }
}

function edgeAnchor(edge: CavityEdge, direction: DrainAnchor["direction"]): DrainAnchor {
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (const run of edge.runs) {
    const width = run.x1 - run.x0 + 1;
    count += width;
    sumX += (run.x0 + run.x1) * width / 2;
    sumY += run.y * width;
  }
  const meanX = sumX / count;
  const meanY = sumY / count;
  let bestX = edge.runs[0].x0;
  let bestY = edge.runs[0].y;
  let bestD2 = Infinity;
  for (const run of edge.runs) {
    const x = Math.max(run.x0, Math.min(run.x1, Math.round(meanX)));
    const d2 = (x - meanX) ** 2 + (run.y - meanY) ** 2;
    if (d2 < bestD2) {
      bestX = x;
      bestY = run.y;
      bestD2 = d2;
    }
  }
  return { x: bestX, y: bestY, layer: edge.layer, direction };
}

/** Find a bottom and top drain centre for every 6-connected cavity component. */
function findDrainAnchors(solid: SliceResult, shell: Uint8Array[]): DrainAnchor[] {
  const W = solid.resolutionX;
  const H = solid.resolutionY;
  let previous: CavityRun[][] = Array.from({ length: H }, () => []);
  const anchors: DrainAnchor[] = [];
  const appendAnchors = (component: CavityComponent) => {
    const root = cavityRoot(component);
    anchors.push(edgeAnchor(root.bottom, "bottom"));
    anchors.push(edgeAnchor(root.top, "top"));
  };

  for (let layer = 0; layer < solid.layers.length; layer++) {
    const src = solid.layers[layer].data;
    const dst = shell[layer];
    const current: CavityRun[][] = Array.from({ length: H }, () => []);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W;) {
        while (x < W && (!src[row + x] || dst[row + x])) x++;
        if (x === W) break;
        const x0 = x;
        while (x + 1 < W && src[row + x + 1] && !dst[row + x + 1]) x++;
        const x1 = x;
        const component = {} as CavityComponent;
        component.parent = component;
        component.size = x1 - x0 + 1;
        component.bottom = { layer, runs: [{ x0, x1, y }] };
        component.top = { layer, runs: [{ x0, x1, y }] };
        const run = { x0, x1, component };
        if (y > 0) connectOverlapping(run, current[y - 1]);
        connectOverlapping(run, previous[y]);
        current[y].push(run);
        x++;
      }
    }

    const currentRoots = new Set<CavityComponent>();
    for (const row of current) for (const run of row) currentRoots.add(cavityRoot(run.component));
    const previousRoots = new Set<CavityComponent>();
    for (const row of previous) for (const run of row) previousRoots.add(cavityRoot(run.component));
    for (const root of previousRoots) {
      if (!currentRoots.has(root)) appendAnchors(root);
    }
    previous = current;
  }

  const remainingRoots = new Set<CavityComponent>();
  for (const row of previous) for (const run of row) remainingRoots.add(cavityRoot(run.component));
  for (const root of remainingRoots) appendAnchors(root);
  return anchors;
}

/** Carve one continuous Z cylinder from the exterior through the shell into the cavity. */
function carveDrainCylinder(
  shell: Uint8Array[], anchor: DrainAnchor,
  rx: number, ry: number, W: number, H: number
) {
  const first = anchor.direction === "bottom" ? 0 : anchor.layer;
  const last = anchor.direction === "bottom" ? anchor.layer : shell.length - 1;
  for (let layer = first; layer <= last; layer++) {
    carveEllipse(shell[layer], anchor.x, anchor.y, rx, ry, W, H);
  }
}

/**
 * Znovu otevře naplánované otvory v již složeném výsledku. Pipeline to volá
 * také po supportech a raftu, aby žádná pozdější operace odtok omylem nezalila.
 */
export function carveDrainHolesInPlace(
  slice: SliceResult,
  anchors: DrainAnchor[],
  holeDiaMm: number,
  mmPerPx: { x: number; y: number },
): void {
  if (anchors.length === 0 || holeDiaMm <= 0) return;
  const rx = Math.max(1, Math.round((holeDiaMm / 2) / mmPerPx.x));
  const ry = Math.max(1, Math.round((holeDiaMm / 2) / mmPerPx.y));
  const layers = slice.layers.map((layer) => layer.data);
  for (const anchor of anchors) {
    carveDrainCylinder(layers, anchor, rx, ry, slice.resolutionX, slice.resolutionY);
  }
}

/**
 * Hollow a solid raster with a separable 3D box erosion. Pixels that have a
 * complete wall-sized neighbourhood are removed; all other pixels remain shell.
 * Optional automatic drain holes are real Z cylinders from the first and last
 * cavity layer through the corresponding exterior face.
 */
export function applyHollow(
  slice: SliceResult,
  opts: HollowOptions,
  mmPerPx: { x: number; y: number },
  onDrainAnchors?: (anchors: DrainAnchor[]) => void,
): SliceResult {
  if (!opts.enabled) return slice;
  const W = slice.resolutionX;
  const H = slice.resolutionY;
  const wallRadiusX = Math.max(1, Math.round(opts.wallMm / mmPerPx.x));
  const wallRadiusY = Math.max(1, Math.round(opts.wallMm / mmPerPx.y));
  const wallLayers = Math.max(1, Math.ceil(opts.wallMm / slice.layerHeight));
  // Keep the requested physical diameter even when X/Y pixel pitch differs.
  const holeRx = Math.max(1, Math.round((opts.holeDiaMm / 2) / mmPerPx.x));
  const holeRy = Math.max(1, Math.round((opts.holeDiaMm / 2) / mmPerPx.y));

  const N = slice.layers.length;
  const out: Uint8Array[] = Array.from({ length: N });

  // XY eroze jedné vrstvy přes integrální obraz: kontroluje celé okolí,
  // nikoli jen čtyři vzdálené vzorky. Každá vrstva se spočítá právě jednou.
  const integralStride = W + 1;
  const integral = new Uint32Array((W + 1) * (H + 1));
  const erodeXY = (src: Uint8Array) => {
    const dst = new Uint8Array(W * H);
    if (!hasPixels(src) || W <= wallRadiusX * 2 || H <= wallRadiusY * 2) return dst;
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
    const spanX = wallRadiusX * 2 + 1;
    const spanY = wallRadiusY * 2 + 1;
    const area = spanX * spanY;
    for (let y = wallRadiusY; y < H - wallRadiusY; y++) {
      const y0 = y - wallRadiusY;
      const y1 = y + wallRadiusY + 1;
      const row = y * W;
      for (let x = wallRadiusX; x < W - wallRadiusX; x++) {
        if (!src[row + x]) continue;
        const x0 = x - wallRadiusX;
        const x1 = x + wallRadiusX + 1;
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
    out[i] = layer;

    const leaving = i - wallLayers;
    addLayer(leaving, -1);
    cache.delete(leaving);
    addLayer(i + wallLayers + 1, 1);
  }

  if (opts.drainHoles && opts.holeDiaMm > 0) {
    // The anchor is a pixel removed by hollowing. Carving every layer between it
    // and an exterior Z face therefore guarantees a connected drainage path.
    const anchors = findDrainAnchors(slice, out);
    onDrainAnchors?.(anchors);
    for (const anchor of anchors) carveDrainCylinder(out, anchor, holeRx, holeRy, W, H);
  } else {
    onDrainAnchors?.([]);
  }

  return {
    ...slice,
    layers: out.map((data, index) => ({ index, z: slice.layers[index].z, data })),
  };
}
