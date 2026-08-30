import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import type { StlMesh } from "../lib/stl";

const geometryModule = path.resolve("lib/viewportGeometry.ts");
assert.ok(
  fs.existsSync(geometryModule),
  "viewport Model must use a testable geometry builder that owns its mutable Three.js arrays",
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildViewportModelGeometry } = require(geometryModule) as {
  buildViewportModelGeometry: (
    mesh: StlMesh,
    offset: { x: number; y: number },
  ) => THREE.BufferGeometry;
};

const sourcePositions = new Float32Array([
  10, 20, 0,
  30, 20, 0,
  10, 60, 18,
]);
const sourceNormals = new Float32Array([
  0, 0, 1,
  0, 0, 1,
  0, 0, 1,
]);
const positionsBefore = new Float32Array(sourcePositions);
const normalsBefore = new Float32Array(sourceNormals);
const sourceBounds = { min: [10, 20, 0], max: [30, 60, 18] } as StlMesh["bounds"];
const boundsBefore = structuredClone(sourceBounds);
const mesh: StlMesh = {
  positions: sourcePositions,
  normals: sourceNormals,
  triangleCount: 1,
  bounds: sourceBounds,
};

const geometry = buildViewportModelGeometry(mesh, { x: -20, y: -40 });

assert.deepEqual(
  sourcePositions,
  positionsBefore,
  "centering a Three.js viewport geometry must never mutate slicer vertex data",
);
assert.deepEqual(
  sourceNormals,
  normalsBefore,
  "viewport geometry must not share mutable normal data with the slicer mesh",
);
assert.deepEqual(sourceBounds, boundsBefore, "viewport rendering must not invalidate slicer bounds");

const viewportPositions = geometry.getAttribute("position").array as Float32Array;
const viewportNormals = geometry.getAttribute("normal").array as Float32Array;
assert.notStrictEqual(viewportPositions.buffer, sourcePositions.buffer);
assert.notStrictEqual(viewportNormals.buffer, sourceNormals.buffer);
assert.deepEqual(
  viewportPositions,
  new Float32Array([
    -10, -20, 0,
    10, -20, 0,
    -10, 20, 18,
  ]),
  "viewport geometry must be centered without changing the slicer's coordinate space",
);

geometry.dispose();
console.log("viewport mesh immutability tests passed");
