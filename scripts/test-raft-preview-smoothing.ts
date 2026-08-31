import assert from "node:assert/strict";
import { buildRaftPreviewGeometries } from "../components/Viewport";
import type { PrinterProfile } from "../lib/profiles";
import type { SupportPreviewData } from "../lib/supports";

const W = 8;
const H = 8;
const staircase = new Uint8Array(W * H);
for (let y = 1; y < 7; y++) {
  for (let x = 1; x <= y; x++) staircase[y * W + x] = 1;
}

const preview: SupportPreviewData = {
  resolutionX: W,
  resolutionY: H,
  layerHeight: 0.1,
  radiusPx: 1,
  tipPx: 1,
  bottomRadiusPx: 1,
  braceRadiusPx: 1,
  pillars: [],
  braces: [],
  raftLayerMasks: [staircase],
};
const printer: PrinterProfile = {
  id: "preview-test",
  name: "Preview test",
  brand: "Test",
  resX: W,
  resY: H,
  printX: W,
  printY: H,
  printZ: 20,
  pixelXUm: 1000,
  pixelYUm: 1000,
  keySuffix: "test",
  keyImageFormat: "test",
};

const geometries = buildRaftPreviewGeometries(preview, printer);
assert.equal(geometries.length, 1, "green raft produces one preview mesh");
const positions = geometries[0].getAttribute("position");
const uniqueXY = new Set<string>();
let subPixelContourPoints = 0;
for (let i = 0; i < positions.count; i++) {
  const x = positions.getX(i);
  const y = positions.getY(i);
  const key = `${x.toFixed(6)},${y.toFixed(6)}`;
  if (uniqueXY.has(key)) continue;
  uniqueXY.add(key);
  if (Math.abs(x - Math.round(x)) > 1e-6 || Math.abs(y - Math.round(y)) > 1e-6) {
    subPixelContourPoints++;
  }
}
geometries.forEach((geometry) => geometry.dispose());
assert.equal(
  subPixelContourPoints,
  uniqueXY.size,
  "every corner of the green staircase contour is visually interpolated off the voxel grid",
);

const annulus = new Uint8Array(W * H);
for (let y = 1; y < 7; y++) annulus.fill(1, y * W + 1, y * W + 7);
for (let y = 3; y < 5; y++) annulus.fill(0, y * W + 3, y * W + 5);
const annulusBefore = new Uint8Array(annulus);
const annulusGeometry = buildRaftPreviewGeometries({
  ...preview,
  raftLayerMasks: [annulus],
}, printer)[0];
assert.deepEqual(annulus, annulusBefore, "visual smoothing never mutates the printable raft mask");

const cap = annulusGeometry.getAttribute("position");
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
const triangleContainsOrigin = (i: number) => {
  const ax = cap.getX(i), ay = cap.getY(i);
  const bx = cap.getX(i + 1), by = cap.getY(i + 1);
  const cx = cap.getX(i + 2), cy = cap.getY(i + 2);
  const c1 = cross(bx - ax, by - ay, -ax, -ay);
  const c2 = cross(cx - bx, cy - by, -bx, -by);
  const c3 = cross(ax - cx, ay - cy, -cx, -cy);
  return (c1 >= -1e-6 && c2 >= -1e-6 && c3 >= -1e-6) ||
    (c1 <= 1e-6 && c2 <= 1e-6 && c3 <= 1e-6);
};
let centerCovered = false;
for (let i = 0; i < cap.count; i += 3) {
  const z0 = cap.getZ(i), z1 = cap.getZ(i + 1), z2 = cap.getZ(i + 2);
  const isCap = Math.abs(z0 - z1) < 1e-6 && Math.abs(z1 - z2) < 1e-6;
  if (isCap && triangleContainsOrigin(i)) {
    centerCovered = true;
    break;
  }
}
annulusGeometry.dispose();
assert.equal(centerCovered, false, "smooth green raft keeps the tray center open");
console.log("[OK] green raft preview uses a smooth visual contour");
