import assert from "node:assert/strict";
import { buildFullResRaftRuns } from "../lib/fullRes";

function referenceRaft(
  front: Uint16Array,
  back: Uint16Array,
  zq: number,
  width: number,
  height: number,
  radiusX: number,
  radiusY: number,
) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let filled = false;
      for (let yy = Math.max(0, y - radiusY); yy <= Math.min(height - 1, y + radiusY) && !filled; yy++) {
        for (let xx = Math.max(0, x - radiusX); xx <= Math.min(width - 1, x + radiusX); xx++) {
          const p = yy * width + xx;
          if (front[p] < zq && zq < back[p]) {
            filled = true;
            break;
          }
        }
      }
      out[y * width + x] = filled ? 1 : 0;
    }
  }
  return out;
}

const W = 19;
const H = 13;
const n = W * H;
const front = new Uint16Array(n);
const back = new Uint16Array(n);
front.fill(65535);
for (const [x0, x1, y] of [[2, 4, 2], [9, 13, 6], [15, 15, 10]] as const) {
  for (let x = x0; x <= x1; x++) {
    front[y * W + x] = 10;
    back[y * W + x] = 100;
  }
}

for (const [radiusX, radiusY] of [[0, 0], [1, 1], [3, 1], [1, 3], [20, 7]] as const) {
  const runs = buildFullResRaftRuns(front, back, 50, W, H, radiusX, radiusY);
  const actual = new Uint8Array(n);
  for (let y = 0; y < H; y++) {
    for (let k = runs.rowOffsets[y]; k < runs.rowOffsets[y + 1]; k += 2) {
      actual.fill(1, y * W + runs.spans[k], y * W + runs.spans[k + 1] + 1);
    }
  }
  assert.deepEqual(
    actual,
    referenceRaft(front, back, 50, W, H, radiusX, radiusY),
    `raft radii ${radiusX}x${radiusY}`,
  );
}

// The representation is proportional to row spans, not white pixels. A dense
// 12K raft must therefore remain a few KiB rather than a 225 MiB Uint32 index.
const denseW = 11520;
const denseH = 5120;
const denseN = denseW * denseH;
const denseFront = new Uint16Array(denseN);
const denseBack = new Uint16Array(denseN);
denseBack.fill(100);
const before = process.memoryUsage().arrayBuffers;
const started = performance.now();
const denseRuns = buildFullResRaftRuns(denseFront, denseBack, 50, denseW, denseH, 300, 240);
const elapsed = performance.now() - started;
const allocated = process.memoryUsage().arrayBuffers - before;
assert.equal(denseRuns.spans.length, denseH * 2, "dense raft is one span per row");
assert.ok(allocated < 16 * 1024 * 1024, `raft scratch/runs allocated ${(allocated / 1024 / 1024).toFixed(1)} MiB`);
console.log(
  `[OK] 12K dense raft ${(elapsed / 1000).toFixed(2)} s, ` +
  `${(allocated / 1024 / 1024).toFixed(1)} MiB temporary/run storage`
);
