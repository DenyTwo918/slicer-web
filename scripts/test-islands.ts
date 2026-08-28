import { strict as assert } from "node:assert";
import { analyzeLayerComponents, detectIslands } from "../lib/islands";
import { makeBox } from "../lib/demo";
import { runSlicePipeline } from "../lib/pipeline";
import type { SliceResult } from "../lib/slice";
import { translateMesh } from "../lib/transform";

const W = 8;
const H = 7;
function pixels(points: Array<[number, number]>, value = 1): Uint8Array {
  const data = new Uint8Array(W * H);
  for (const [x, y] of points) data[y * W + x] = value;
  return data;
}

const slice: SliceResult = {
  resolutionX: W,
  resolutionY: H,
  layerHeight: 0.05,
  minX: 0,
  minY: 0,
  layers: [
    { index: 10, z: 0.025, data: pixels([[1, 1], [1, 2]]) },
    {
      index: 11,
      z: 0.075,
      data: pixels([
        [1, 1], [1, 2], // komponenta podepřená přesným překryvem
        [5, 1], [6, 2], // diagonálně spojený nový island
        [7, 6], // šum odfiltrovaný přes minPixels
      ]),
    },
    {
      index: 12,
      z: 0.125,
      // Pouhý diagonální dotyk minulé vrstvy není překryv.
      data: pixels([[6, 3], [5, 4]]),
    },
  ],
};

const components = analyzeLayerComponents(slice, { minPixels: 2 });
assert.equal(components.length, 3);
assert.equal(components[0].unsupported, false);
assert.equal(components[0].previousOverlapPixels, 2);
assert.equal(components[1].unsupported, true);
assert.equal(components[1].pixelCount, 2, "8-connectivity musí spojit diagonální pixely");
assert.deepEqual(components[1].bbox, { minX: 5, minY: 1, maxX: 6, maxY: 2, width: 2, height: 2 });
assert.deepEqual(components[1].centroid, { x: 5.5, y: 1.5 });

const islands = detectIslands(slice, { minPixels: 2 });
assert.deepEqual(islands.map((x) => [x.layer, x.layerIndex, x.pixelCount]), [[1, 11, 2], [2, 12, 2]]);
assert.equal(islands[1].previousOverlapPixels, 0);

assert.equal(detectIslands(slice).some((x) => x.pixelCount === 1), true, "výchozí minPixels je 1");
assert.equal(detectIslands(slice, { includeFirstLayer: true }).some((x) => x.layer === 0), true);
assert.equal(detectIslands(slice, { threshold: 2 }).length, 0, "threshold musí respektovat AA hodnoty");

assert.throws(() => detectIslands({ ...slice, resolutionX: 9 }), /expected/);

const pipelineSettings = {
  layerHeight: 0.5,
  hollow: false,
  wallMm: 1,
  holeDiaMm: 1,
  drainHoles: false,
  supports: false,
  supportRadiusMm: 1,
  supportTipMm: 0.5,
  raft: false,
  raftLayers: 0,
  raftMarginMm: 1,
  aa: true,
};

const bottom = makeBox(2, 1);
const microIsland = translateMesh(makeBox(1, 0.5), 0, 0, 1.5);

Promise.resolve().then(async () => {
  const pipeline = await runSlicePipeline(
    [
      { positions: bottom.positions, bounds: bottom.bounds, triangleCount: bottom.triangleCount, tx: -4, ty: 0 },
      {
        positions: microIsland.positions,
        bounds: microIsland.bounds,
        triangleCount: microIsland.triangleCount,
        tx: 3.5,
        ty: 0.5,
      },
    ],
    pipelineSettings,
    { resX: 17, resY: 17, printX: 17, printY: 17 },
    { forceCpu: true },
  );

  const islandLayer = pipeline.result!.layers[3].data;
  assert.ok(Math.max(...islandLayer) < 128, "AA must blur the 1px island below the old diagnostic threshold");
  assert.equal(pipeline.diagnostics.islandCount, 1, "pipeline must diagnose a 1px island before AA blurs it");
  assert.equal(pipeline.diagnostics.islands[0].pixelCount, 1);

  console.log("PASS islands");
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
