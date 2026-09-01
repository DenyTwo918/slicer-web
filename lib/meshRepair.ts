import type { StlMesh } from "./stl";
import { buildMeshTopology } from "./meshTopology";

export type MeshIssueKind =
  | "degenerate-triangle"
  | "duplicate-face"
  | "boundary-edge"
  | "non-manifold-edge"
  | "inconsistent-winding"
  | "tiny-shell";

export interface MeshIssueSample {
  kind: MeshIssueKind;
  triangleIndices: number[];
  /** Kompaktní svařené vertex ID z topologie. */
  edgeVertices?: [number, number];
  /** Skutečné souřadnice hrany pro levný viewport overlay bez nové topologické analýzy. */
  edgePoints?: [[number, number, number], [number, number, number]];
}

export interface MeshIssueGroup {
  count: number;
  samples: MeshIssueSample[];
}

export interface MeshRepairReport {
  triangleCount: number;
  shellCount: number;
  degenerateTriangles: MeshIssueGroup;
  duplicateFaces: MeshIssueGroup;
  boundaryEdges: MeshIssueGroup;
  nonManifoldEdges: MeshIssueGroup;
  inconsistentWinding: MeshIssueGroup;
  tinyShells: MeshIssueGroup;
  repairableCount: number;
  unresolvedCount: number;
}

export interface MeshAnalysisOptions {
  weldToleranceMm?: number;
  maxSamplesPerKind?: number;
  tinyShellMaxTriangles?: number;
  tinyShellMaxSizeMm?: number;
}

export interface MeshRepairPlan {
  removeDegenerateTriangles: number[];
  removeDuplicateTriangles: number[];
  flipTriangles: number[];
  unresolvedWindingComponents: number;
}

export interface MeshRepairResult {
  mesh: StlMesh;
  sourceTriangleIndices: number[];
  removedDegenerate: number;
  removedDuplicates: number;
  flippedTriangles: number;
}

function makeGroup(samples: MeshIssueSample[], totalCount: number): MeshIssueGroup {
  return { count: totalCount, samples };
}

function edgePoints(
  representativePositions: Float32Array,
  vertices: [number, number],
): [[number, number, number], [number, number, number]] {
  const point = (vertex: number): [number, number, number] => {
    const offset = vertex * 3;
    return [
      representativePositions[offset],
      representativePositions[offset + 1],
      representativePositions[offset + 2],
    ];
  };
  return [point(vertices[0]), point(vertices[1])];
}

function triangleArea(mesh: StlMesh, triangleIndex: number): number {
  const offset = triangleIndex * 9;
  const ax = mesh.positions[offset + 3] - mesh.positions[offset];
  const ay = mesh.positions[offset + 4] - mesh.positions[offset + 1];
  const az = mesh.positions[offset + 5] - mesh.positions[offset + 2];
  const bx = mesh.positions[offset + 6] - mesh.positions[offset];
  const by = mesh.positions[offset + 7] - mesh.positions[offset + 1];
  const bz = mesh.positions[offset + 8] - mesh.positions[offset + 2];
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  return Math.hypot(nx, ny, nz) * 0.5;
}

function modelDiagonal(mesh: StlMesh): number {
  return Math.hypot(
    mesh.bounds.max[0] - mesh.bounds.min[0],
    mesh.bounds.max[1] - mesh.bounds.min[1],
    mesh.bounds.max[2] - mesh.bounds.min[2],
  );
}

function shellSize(mesh: StlMesh, triangles: number[]): number {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const triangle of triangles) {
    const base = triangle * 9;
    for (let vertex = 0; vertex < 3; vertex++) {
      const offset = base + vertex * 3;
      for (let axis = 0; axis < 3; axis++) {
        const value = mesh.positions[offset + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
  }
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

export function analyzeMesh(
  mesh: StlMesh,
  options: MeshAnalysisOptions = {},
): MeshRepairReport {
  const maxSamples = Math.max(0, Math.floor(options.maxSamplesPerKind ?? 100));
  const topology = buildMeshTopology(mesh, { weldToleranceMm: options.weldToleranceMm });
  const diagonal = modelDiagonal(mesh);
  const areaEpsilon = Math.max(1e-12, diagonal * diagonal * 1e-14);

  const degenerate = new Uint8Array(mesh.triangleCount);
  const degenerateSamples: MeshIssueSample[] = [];
  let degenerateCount = 0;
  for (let triangle = 0; triangle < mesh.triangleCount; triangle++) {
    const base = triangle * 3;
    const a = topology.weldedVertexByOccurrence[base];
    const b = topology.weldedVertexByOccurrence[base + 1];
    const c = topology.weldedVertexByOccurrence[base + 2];
    if (a === b || b === c || c === a || triangleArea(mesh, triangle) <= areaEpsilon) {
      degenerate[triangle] = 1;
      degenerateCount++;
      if (degenerateSamples.length < maxSamples) {
        degenerateSamples.push({ kind: "degenerate-triangle", triangleIndices: [triangle] });
      }
    }
  }

  const duplicate = new Uint8Array(mesh.triangleCount);
  const firstTriangleByFace = new Map<string, number>();
  const duplicateSamples: MeshIssueSample[] = [];
  let duplicateCount = 0;
  for (let triangle = 0; triangle < mesh.triangleCount; triangle++) {
    if (degenerate[triangle]) continue;
    const base = triangle * 3;
    const vertices = [
      topology.weldedVertexByOccurrence[base],
      topology.weldedVertexByOccurrence[base + 1],
      topology.weldedVertexByOccurrence[base + 2],
    ].sort((a, b) => a - b);
    const key = `${vertices[0]}|${vertices[1]}|${vertices[2]}`;
    if (firstTriangleByFace.has(key)) {
      duplicate[triangle] = 1;
      duplicateCount++;
      if (duplicateSamples.length < maxSamples) {
        duplicateSamples.push({ kind: "duplicate-face", triangleIndices: [triangle] });
      }
    } else {
      firstTriangleByFace.set(key, triangle);
    }
  }

  const retained = (triangle: number) => !degenerate[triangle] && !duplicate[triangle];
  const boundarySamples: MeshIssueSample[] = [];
  const nonManifoldSamples: MeshIssueSample[] = [];
  const windingSamples: MeshIssueSample[] = [];
  let boundaryCount = 0;
  let nonManifoldCount = 0;
  let windingCount = 0;
  const retainedNeighbors = Array.from({ length: mesh.triangleCount }, () => new Set<number>());

  for (const edge of topology.edges) {
    const uses = edge.uses.filter((use) => retained(use.triangleIndex));
    if (uses.length === 0) continue;
    if (uses.length === 1) {
      boundaryCount++;
      if (boundarySamples.length < maxSamples) {
        boundarySamples.push({
          kind: "boundary-edge",
          triangleIndices: [uses[0].triangleIndex],
          edgeVertices: edge.vertices,
          edgePoints: edgePoints(topology.representativePositions, edge.vertices),
        });
      }
    } else if (uses.length > 2) {
      nonManifoldCount++;
      if (nonManifoldSamples.length < maxSamples) {
        nonManifoldSamples.push({
          kind: "non-manifold-edge",
          triangleIndices: uses.map((use) => use.triangleIndex).sort((a, b) => a - b),
          edgeVertices: edge.vertices,
          edgePoints: edgePoints(topology.representativePositions, edge.vertices),
        });
      }
    }
    if (uses.length === 2) {
      const [first, second] = uses;
      retainedNeighbors[first.triangleIndex].add(second.triangleIndex);
      retainedNeighbors[second.triangleIndex].add(first.triangleIndex);
      if (first.startVertex === second.startVertex && first.endVertex === second.endVertex) {
        windingCount++;
        if (windingSamples.length < maxSamples) {
          windingSamples.push({
            kind: "inconsistent-winding",
            triangleIndices: [first.triangleIndex, second.triangleIndex].sort((a, b) => a - b),
            edgeVertices: edge.vertices,
            edgePoints: edgePoints(topology.representativePositions, edge.vertices),
          });
        }
      }
    } else if (uses.length > 2) {
      for (let i = 0; i < uses.length; i++) {
        for (let j = i + 1; j < uses.length; j++) {
          retainedNeighbors[uses[i].triangleIndex].add(uses[j].triangleIndex);
          retainedNeighbors[uses[j].triangleIndex].add(uses[i].triangleIndex);
        }
      }
    }
  }

  const shells: number[][] = [];
  const visited = new Uint8Array(mesh.triangleCount);
  for (let first = 0; first < mesh.triangleCount; first++) {
    if (!retained(first) || visited[first]) continue;
    const queue = [first];
    visited[first] = 1;
    const shell: number[] = [];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const triangle = queue[cursor];
      shell.push(triangle);
      for (const neighbor of retainedNeighbors[triangle]) {
        if (!visited[neighbor]) {
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }
    shell.sort((a, b) => a - b);
    shells.push(shell);
  }

  const tinyMaxTriangles = Math.max(1, Math.floor(options.tinyShellMaxTriangles ?? 2));
  const tinyMaxSize = options.tinyShellMaxSizeMm ?? Math.max(0.1, diagonal * 0.01);
  const tinySamples: MeshIssueSample[] = [];
  let tinyCount = 0;
  if (shells.length > 1) {
    for (const shell of shells) {
      if (shell.length <= tinyMaxTriangles && shellSize(mesh, shell) <= tinyMaxSize) {
        tinyCount++;
        if (tinySamples.length < maxSamples) {
          tinySamples.push({ kind: "tiny-shell", triangleIndices: shell });
        }
      }
    }
  }

  return {
    triangleCount: mesh.triangleCount,
    shellCount: shells.length,
    degenerateTriangles: makeGroup(degenerateSamples, degenerateCount),
    duplicateFaces: makeGroup(duplicateSamples, duplicateCount),
    boundaryEdges: makeGroup(boundarySamples, boundaryCount),
    nonManifoldEdges: makeGroup(nonManifoldSamples, nonManifoldCount),
    inconsistentWinding: makeGroup(windingSamples, windingCount),
    tinyShells: makeGroup(tinySamples, tinyCount),
    repairableCount: degenerateCount + duplicateCount + windingCount,
    unresolvedCount: boundaryCount + nonManifoldCount + tinyCount,
  };
}

export function planSafeMeshRepair(mesh: StlMesh, report: MeshRepairReport): MeshRepairPlan {
  if (report.triangleCount !== mesh.triangleCount) {
    throw new Error("Report opravy neodpovídá aktuálnímu modelu.");
  }

  // Dry-run potřebuje úplné indexy, zatímco běžný UI report smí mít omezené vzorky.
  const fullReport = analyzeMesh(mesh, { maxSamplesPerKind: mesh.triangleCount * 3 });
  const removeDegenerateTriangles = fullReport.degenerateTriangles.samples
    .map((sample) => sample.triangleIndices[0])
    .sort((a, b) => a - b);
  const removeDuplicateTriangles = fullReport.duplicateFaces.samples
    .map((sample) => sample.triangleIndices[0])
    .sort((a, b) => a - b);
  const removed = new Set([...removeDegenerateTriangles, ...removeDuplicateTriangles]);
  const topology = buildMeshTopology(mesh);

  type Constraint = { triangle: number; xor: 0 | 1 };
  const constraints: Constraint[][] = Array.from({ length: mesh.triangleCount }, () => []);
  for (const edge of topology.edges) {
    const uses = edge.uses.filter((use) => !removed.has(use.triangleIndex));
    if (uses.length !== 2) continue;
    const [a, b] = uses;
    const sameDirection = a.startVertex === b.startVertex && a.endVertex === b.endVertex;
    const xor: 0 | 1 = sameDirection ? 1 : 0;
    constraints[a.triangleIndex].push({ triangle: b.triangleIndex, xor });
    constraints[b.triangleIndex].push({ triangle: a.triangleIndex, xor });
  }
  for (const list of constraints) list.sort((a, b) => a.triangle - b.triangle || a.xor - b.xor);

  const assignment = new Int8Array(mesh.triangleCount);
  assignment.fill(-1);
  const flipTriangles: number[] = [];
  let unresolvedWindingComponents = 0;

  for (let first = 0; first < mesh.triangleCount; first++) {
    if (removed.has(first) || assignment[first] !== -1) continue;
    assignment[first] = 0;
    const queue = [first];
    const component: number[] = [];
    let conflict = false;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const triangle = queue[cursor];
      component.push(triangle);
      for (const constraint of constraints[triangle]) {
        const expected = (assignment[triangle] ^ constraint.xor) as 0 | 1;
        if (assignment[constraint.triangle] === -1) {
          assignment[constraint.triangle] = expected;
          queue.push(constraint.triangle);
        } else if (assignment[constraint.triangle] !== expected) {
          conflict = true;
        }
      }
    }
    if (conflict) {
      unresolvedWindingComponents++;
      continue;
    }

    const ones = component.filter((triangle) => assignment[triangle] === 1).length;
    const flipValue = ones <= component.length - ones ? 1 : 0;
    for (const triangle of component) {
      if (assignment[triangle] === flipValue) flipTriangles.push(triangle);
    }
  }

  flipTriangles.sort((a, b) => a - b);
  return {
    removeDegenerateTriangles,
    removeDuplicateTriangles,
    flipTriangles,
    unresolvedWindingComponents,
  };
}

function normalForTriangle(positions: Float32Array, offset: number): [number, number, number] {
  const ax = positions[offset + 3] - positions[offset];
  const ay = positions[offset + 4] - positions[offset + 1];
  const az = positions[offset + 5] - positions[offset + 2];
  const bx = positions[offset + 6] - positions[offset];
  const by = positions[offset + 7] - positions[offset + 1];
  const bz = positions[offset + 8] - positions[offset + 2];
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const length = Math.hypot(nx, ny, nz) || 1;
  return [nx / length, ny / length, nz / length];
}

export function applySafeMeshRepair(mesh: StlMesh, plan: MeshRepairPlan): MeshRepairResult {
  const degenerate = new Set(plan.removeDegenerateTriangles);
  const duplicates = new Set(plan.removeDuplicateTriangles);
  const removed = new Set([...degenerate, ...duplicates]);
  const flips = new Set(plan.flipTriangles);
  const sourceTriangleIndices: number[] = [];
  for (let triangle = 0; triangle < mesh.triangleCount; triangle++) {
    if (!removed.has(triangle)) sourceTriangleIndices.push(triangle);
  }
  if (sourceTriangleIndices.length === 0) {
    throw new Error("Bezpečná oprava by vytvořila prázdný model.");
  }

  for (const index of [...removed, ...flips]) {
    if (!Number.isInteger(index) || index < 0 || index >= mesh.triangleCount) {
      throw new Error(`Plán opravy obsahuje neplatný index trojúhelníku: ${index}.`);
    }
  }

  const positions = new Float32Array(sourceTriangleIndices.length * 9);
  const normals = new Float32Array(sourceTriangleIndices.length * 9);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  sourceTriangleIndices.forEach((sourceTriangle, outputTriangle) => {
    const sourceOffset = sourceTriangle * 9;
    const outputOffset = outputTriangle * 9;
    positions.set(mesh.positions.subarray(sourceOffset, sourceOffset + 9), outputOffset);
    if (flips.has(sourceTriangle)) {
      for (let axis = 0; axis < 3; axis++) {
        const temp = positions[outputOffset + 3 + axis];
        positions[outputOffset + 3 + axis] = positions[outputOffset + 6 + axis];
        positions[outputOffset + 6 + axis] = temp;
      }
    }
    const normal = normalForTriangle(positions, outputOffset);
    for (let vertex = 0; vertex < 3; vertex++) {
      const offset = outputOffset + vertex * 3;
      normals.set(normal, offset);
      for (let axis = 0; axis < 3; axis++) {
        const value = positions[offset + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
  });

  return {
    mesh: {
      positions,
      normals,
      triangleCount: sourceTriangleIndices.length,
      bounds: { min, max },
    },
    sourceTriangleIndices,
    removedDegenerate: degenerate.size,
    removedDuplicates: duplicates.size,
    flippedTriangles: sourceTriangleIndices.filter((triangle) => flips.has(triangle)).length,
  };
}
