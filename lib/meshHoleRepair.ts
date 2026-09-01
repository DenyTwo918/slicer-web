import type { MeshTopology } from "./meshTopology";
import type { StlMesh } from "./stl";

export type MeshPoint3 = [number, number, number];
export type MeshPatchTriangle = [MeshPoint3, MeshPoint3, MeshPoint3];

export interface BoundaryFillPlan {
  triangles: MeshPatchTriangle[];
  loopCount: number;
  repairedBoundaryEdgeCount: number;
}

const MAX_SAFE_LOOP_VERTICES = 4096;

function pointAt(positions: Float32Array, vertex: number): MeshPoint3 {
  const offset = vertex * 3;
  return [positions[offset], positions[offset + 1], positions[offset + 2]];
}

function newellNormal(points: MeshPoint3[]): MeshPoint3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    x += (current[1] - next[1]) * (current[2] + next[2]);
    y += (current[2] - next[2]) * (current[0] + next[0]);
    z += (current[0] - next[0]) * (current[1] + next[1]);
  }
  return [x, y, z];
}

type Point2 = [number, number];

function projectPoint(point: MeshPoint3, droppedAxis: number): Point2 {
  if (droppedAxis === 0) return [point[1], point[2]];
  if (droppedAxis === 1) return [point[0], point[2]];
  return [point[0], point[1]];
}

function cross2(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function signedArea(points: Point2[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const next = (index + 1) % points.length;
    area += points[index][0] * points[next][1] - points[next][0] * points[index][1];
  }
  return area * 0.5;
}

function pointInTriangle(point: Point2, a: Point2, b: Point2, c: Point2, orientation: number): boolean {
  const epsilon = 1e-12;
  return orientation * cross2(a, b, point) >= -epsilon
    && orientation * cross2(b, c, point) >= -epsilon
    && orientation * cross2(c, a, point) >= -epsilon;
}

function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const epsilon = 1e-12;
  const abC = cross2(a, b, c);
  const abD = cross2(a, b, d);
  const cdA = cross2(c, d, a);
  const cdB = cross2(c, d, b);
  return ((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon))
    && ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon));
}

function isSimplePolygon(points: Point2[]): boolean {
  for (let first = 0; first < points.length; first++) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second++) {
      const secondNext = (second + 1) % points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(points[first], points[firstNext], points[second], points[secondNext])) {
        return false;
      }
    }
  }
  return true;
}

function triangulateLoop(points: MeshPoint3[]): MeshPatchTriangle[] | null {
  if (points.length < 3 || points.length > MAX_SAFE_LOOP_VERTICES) return null;
  const normal = newellNormal(points);
  const normalLength = Math.hypot(...normal);
  if (!Number.isFinite(normalLength) || normalLength <= 1e-12) return null;

  const centroid: MeshPoint3 = [0, 0, 0];
  for (const point of points) {
    centroid[0] += point[0];
    centroid[1] += point[1];
    centroid[2] += point[2];
  }
  centroid[0] /= points.length;
  centroid[1] /= points.length;
  centroid[2] /= points.length;
  const min: MeshPoint3 = [Infinity, Infinity, Infinity];
  const max: MeshPoint3 = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis++) {
      if (point[axis] < min[axis]) min[axis] = point[axis];
      if (point[axis] > max[axis]) max[axis] = point[axis];
    }
  }
  const loopDiagonal = Math.hypot(
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2],
  );
  // Planarity is local to the hole. A distant part of a very large model must
  // not loosen the tolerance and turn a warped boundary into a flat cap.
  const planeTolerance = Math.max(4e-5, loopDiagonal * 1e-4);
  for (const point of points) {
    const distance = Math.abs(
      normal[0] * (point[0] - centroid[0])
      + normal[1] * (point[1] - centroid[1])
      + normal[2] * (point[2] - centroid[2]),
    ) / normalLength;
    if (distance > planeTolerance) return null;
  }

  const absoluteNormal = normal.map(Math.abs);
  const droppedAxis = absoluteNormal[0] >= absoluteNormal[1] && absoluteNormal[0] >= absoluteNormal[2]
    ? 0
    : absoluteNormal[1] >= absoluteNormal[2] ? 1 : 2;
  const projected = points.map((point) => projectPoint(point, droppedAxis));
  if (!isSimplePolygon(projected)) return null;
  const area = signedArea(projected);
  if (Math.abs(area) <= 1e-12) return null;
  const orientation = Math.sign(area);
  const remaining = points.map((_, index) => index);
  const triangles: MeshPatchTriangle[] = [];

  while (remaining.length > 3) {
    let earFound = false;
    for (let cursor = 0; cursor < remaining.length; cursor++) {
      const previous = remaining[(cursor - 1 + remaining.length) % remaining.length];
      const current = remaining[cursor];
      const next = remaining[(cursor + 1) % remaining.length];
      if (orientation * cross2(projected[previous], projected[current], projected[next]) <= 1e-12) {
        continue;
      }
      let containsVertex = false;
      for (const candidate of remaining) {
        if (candidate === previous || candidate === current || candidate === next) continue;
        if (pointInTriangle(
          projected[candidate],
          projected[previous],
          projected[current],
          projected[next],
          orientation,
        )) {
          containsVertex = true;
          break;
        }
      }
      if (containsVertex) continue;
      triangles.push([points[previous], points[current], points[next]]);
      remaining.splice(cursor, 1);
      earFound = true;
      break;
    }
    if (!earFound) return null;
  }
  triangles.push([points[remaining[0]], points[remaining[1]], points[remaining[2]]]);
  return triangles;
}

export function planSafeBoundaryFill(
  mesh: StlMesh,
  topology: MeshTopology,
  removedTriangles: ReadonlySet<number>,
  flippedTriangles: ReadonlySet<number>,
): BoundaryFillPlan {
  const shellByTriangle = new Int32Array(mesh.triangleCount);
  const survivingTrianglesByShell = new Int32Array(topology.shells.length);
  topology.shells.forEach((shell, shellIndex) => {
    for (const triangle of shell) {
      shellByTriangle[triangle] = shellIndex;
      if (!removedTriangles.has(triangle)) survivingTrianglesByShell[shellIndex]++;
    }
  });

  type DirectedBoundary = { from: number; to: number; shell: number };
  const candidates: DirectedBoundary[] = [];
  for (const edge of topology.edges) {
    const uses = edge.uses.filter((use) => !removedTriangles.has(use.triangleIndex));
    if (uses.length !== 1) continue;
    const use = uses[0];
    const faceStart = flippedTriangles.has(use.triangleIndex) ? use.endVertex : use.startVertex;
    const faceEnd = flippedTriangles.has(use.triangleIndex) ? use.startVertex : use.endVertex;
    candidates.push({
      from: faceEnd,
      to: faceStart,
      shell: shellByTriangle[use.triangleIndex],
    });
  }

  const outgoing = new Map<number, DirectedBoundary[]>();
  const incoming = new Map<number, DirectedBoundary[]>();
  for (const edge of candidates) {
    const from = outgoing.get(edge.from);
    if (from) from.push(edge);
    else outgoing.set(edge.from, [edge]);
    const to = incoming.get(edge.to);
    if (to) to.push(edge);
    else incoming.set(edge.to, [edge]);
  }

  const visited = new Set<DirectedBoundary>();
  const triangles: MeshPatchTriangle[] = [];
  let loopCount = 0;
  let repairedBoundaryEdgeCount = 0;

  for (const first of candidates) {
    if (visited.has(first)) continue;
    const loop: number[] = [];
    const loopEdges: DirectedBoundary[] = [];
    let current = first;
    let safe = true;
    while (!visited.has(current)) {
      visited.add(current);
      loopEdges.push(current);
      loop.push(current.from);
      if (current.shell !== first.shell
        || outgoing.get(current.from)?.length !== 1
        || incoming.get(current.from)?.length !== 1
        || outgoing.get(current.to)?.length !== 1
        || incoming.get(current.to)?.length !== 1) {
        safe = false;
        break;
      }
      const next = outgoing.get(current.to)?.[0];
      if (!next) {
        safe = false;
        break;
      }
      current = next;
    }
    if (current !== first) safe = false;
    if (survivingTrianglesByShell[first.shell] < 3) safe = false;
    if (!safe) continue;
    const patch = triangulateLoop(
      loop.map((vertex) => pointAt(topology.representativePositions, vertex)),
    );
    if (!patch) continue;
    triangles.push(...patch);
    loopCount++;
    repairedBoundaryEdgeCount += loopEdges.length;
  }

  return { triangles, loopCount, repairedBoundaryEdgeCount };
}
