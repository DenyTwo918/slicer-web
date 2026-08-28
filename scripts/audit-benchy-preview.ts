import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { parseStl } from "../lib/stl";
import { runSlicePipeline } from "../lib/pipeline";
import {
  simplifyClosedPreviewContour,
  traceMaskContours,
  type PreviewPoint2,
} from "../lib/previewContour";

function signedArea(loop: PreviewPoint2[]) {
  let twice = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return twice / 2;
}

function pointInLoop(loop: PreviewPoint2[], point: PreviewPoint2) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j];
    if (((a.y > point.y) !== (b.y > point.y)) &&
        point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

async function main() {
  const hollow = process.argv.includes("--hollow");
  const bytes = fs.readFileSync("public/models/3DBenchy.stl");
  const mesh = parseStl(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const sliced = await runSlicePipeline(
    [{ positions: mesh.positions, bounds: mesh.bounds, triangleCount: mesh.triangleCount, tx: 0, ty: 0 }],
    {
      layerHeight: 0.1,
      hollow,
      wallMm: 2,
      holeDiaMm: 3,
      drainHoles: true,
      supports: true,
      supportRadiusMm: 1,
      supportTipMm: 0.5,
      supportMaxAngleDeg: 35,
      supportSpacingMm: 8,
      supportClearanceMm: 1,
      raft: true,
      raftLayers: 3,
      raftMarginMm: 3,
      aa: true,
    },
    { resX: 11520, resY: 5120, printX: 223.642, printY: 126.48 },
    { forceCpu: true },
  );
  assert.ok(sliced.result);
  const result = sliced.result;
  const bad: string[] = [];
  let totalLoops = 0;
  let maxLoops = 0;

  for (let layerIndex = 0; layerIndex < result.layers.length; layerIndex++) {
    const data = result.layers[layerIndex].data;
    const loops = traceMaskContours(data, result.resolutionX, result.resolutionY, 24);
    totalLoops += loops.length;
    maxLoops = Math.max(maxLoops, loops.length);
    let maskArea = 0;
    for (const value of data) if (value > 24) maskArea++;
    const contourArea = loops.reduce((sum, loop) => sum + signedArea(loop), 0);
    if (Math.abs(contourArea - maskArea) > 1e-6) {
      bad.push(`L${layerIndex}: mask area ${maskArea}, contour area ${contourArea}`);
      continue;
    }

    const entries = loops
      .map((loop) => ({ loop: simplifyClosedPreviewContour(loop, 0.75), area: signedArea(loop) }))
      .filter((entry) => entry.loop.length >= 3 && Math.abs(entry.area) >= 4);
    const outers = entries.filter((entry) => entry.area > 0);
    const holesByOuter = new Map<(typeof outers)[number], PreviewPoint2[][]>();
    for (const outer of outers) holesByOuter.set(outer, []);
    for (const hole of entries.filter((entry) => entry.area < 0)) {
      const parent = outers
        .filter((outer) => pointInLoop(outer.loop, hole.loop[0]))
        .sort((a, b) => Math.abs(a.area) - Math.abs(b.area))[0];
      if (!parent) {
        bad.push(`L${layerIndex}: orphan hole`);
        continue;
      }
      holesByOuter.get(parent)!.push(hole.loop);
    }

    for (const outer of outers) {
      const holes = holesByOuter.get(outer)!;
      const contour = outer.loop.map((p) => new THREE.Vector2(p.x, p.y));
      const holeVectors = holes.map((hole) => hole.map((p) => new THREE.Vector2(p.x, p.y)));
      const points = [...contour, ...holeVectors.flat()];
      const triangles = THREE.ShapeUtils.triangulateShape(contour, holeVectors);
      let triangleArea = 0;
      for (const [a, b, c] of triangles) {
        const p = points[a], q = points[b], r = points[c];
        triangleArea += Math.abs((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)) / 2;
      }
      const expected = Math.abs(signedArea(outer.loop))
        - holes.reduce((sum, hole) => sum + Math.abs(signedArea(hole)), 0);
      if (expected > 0 && Math.abs(triangleArea - expected) / expected > 0.01) {
        bad.push(`L${layerIndex}: triangulation ${triangleArea.toFixed(1)} vs ${expected.toFixed(1)}`);
      }
    }
  }

  console.log(
    `Benchy ${hollow ? "hollow" : "solid"} preview audit: ${result.layers.length} layers, ${totalLoops} loops, ` +
    `max ${maxLoops} loops/layer, ${bad.length} defects`,
  );
  if (bad.length) console.log(bad.slice(0, 30).join("\n"));
  assert.equal(bad.length, 0, "every Benchy preview layer must retain contour topology and triangulate cleanly");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
