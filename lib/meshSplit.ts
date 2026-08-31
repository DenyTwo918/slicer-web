import type { StlMesh } from "./stl";

export interface MeshShell {
  mesh: StlMesh;
  /** Indexy trojúhelníků v původním modelu, ve stabilním pořadí. */
  triangleIndices: number[];
}

const DEFAULT_WELD_TOLERANCE_MM = 1e-5;

function faceNormal(positions: Float32Array, offset: number): [number, number, number] {
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

export function extractMeshTriangles(mesh: StlMesh, triangleIndices: number[]): StlMesh {
  if (triangleIndices.length === 0) {
    throw new Error("Nelze vytvořit prázdnou část modelu.");
  }

  const positions = new Float32Array(triangleIndices.length * 9);
  const normals = new Float32Array(triangleIndices.length * 9);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  triangleIndices.forEach((triangleIndex, outputIndex) => {
    if (!Number.isInteger(triangleIndex) || triangleIndex < 0 || triangleIndex >= mesh.triangleCount) {
      throw new Error(`Neplatný index trojúhelníku: ${triangleIndex}.`);
    }
    const sourceOffset = triangleIndex * 9;
    const outputOffset = outputIndex * 9;
    positions.set(mesh.positions.subarray(sourceOffset, sourceOffset + 9), outputOffset);
    const normal = faceNormal(positions, outputOffset);

    for (let vertex = 0; vertex < 3; vertex++) {
      const offset = outputOffset + vertex * 3;
      normals[offset] = normal[0];
      normals[offset + 1] = normal[1];
      normals[offset + 2] = normal[2];
      for (let axis = 0; axis < 3; axis++) {
        const value = positions[offset + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
  });

  return {
    positions,
    normals,
    triangleCount: triangleIndices.length,
    bounds: { min, max },
  };
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Rozdělí triangle soup na souvislé skořepiny. Spojení vzniká pouze přes
 * společnou hranu, ne přes jediný dotýkající se bod. To zabraňuje náhodnému
 * sloučení samostatných dílů STL, které se jen dotýkají vrcholem.
 */
export function splitConnectedShells(
  mesh: StlMesh,
  weldToleranceMm = DEFAULT_WELD_TOLERANCE_MM,
): MeshShell[] {
  if (!Number.isFinite(weldToleranceMm) || weldToleranceMm <= 0) {
    throw new Error("Tolerance spojování musí být kladné konečné číslo.");
  }
  if (mesh.triangleCount === 0) return [];

  // Nejprve svaříme výskyty vrcholů skutečnou vzdáleností. Samotné
  // zaokrouhlení do jedné buňky nestačí: dva blízké body mohou ležet po
  // opačných stranách hranice buňky.
  const vertexCount = mesh.triangleCount * 3;
  const uniqueIndexByCoordinate = new Map<string, number>();
  const uniqueCoordinates: number[] = [];
  const uniqueIndexByVertex = new Int32Array(vertexCount);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * 3;
    const x = mesh.positions[offset];
    const y = mesh.positions[offset + 1];
    const z = mesh.positions[offset + 2];
    const exactKey = `${x},${y},${z}`;
    let uniqueIndex = uniqueIndexByCoordinate.get(exactKey);
    if (uniqueIndex === undefined) {
      uniqueIndex = uniqueCoordinates.length / 3;
      uniqueIndexByCoordinate.set(exactKey, uniqueIndex);
      uniqueCoordinates.push(x, y, z);
    }
    uniqueIndexByVertex[vertex] = uniqueIndex;
  }

  const uniqueVertexCount = uniqueCoordinates.length / 3;
  const vertexParent = new Int32Array(uniqueVertexCount);
  const vertexRank = new Uint8Array(uniqueVertexCount);
  for (let i = 0; i < uniqueVertexCount; i++) vertexParent[i] = i;
  const findVertex = (value: number): number => {
    let root = value;
    while (vertexParent[root] !== root) root = vertexParent[root];
    while (vertexParent[value] !== value) {
      const next = vertexParent[value];
      vertexParent[value] = root;
      value = next;
    }
    return root;
  };
  const unionVertex = (a: number, b: number) => {
    let rootA = findVertex(a);
    let rootB = findVertex(b);
    if (rootA === rootB) return;
    if (vertexRank[rootA] < vertexRank[rootB]) [rootA, rootB] = [rootB, rootA];
    vertexParent[rootB] = rootA;
    if (vertexRank[rootA] === vertexRank[rootB]) vertexRank[rootA]++;
  };

  const vertexBuckets = new Map<string, number[]>();
  const toleranceSquared = weldToleranceMm * weldToleranceMm;
  for (let vertex = 0; vertex < uniqueVertexCount; vertex++) {
    const offset = vertex * 3;
    const x = uniqueCoordinates[offset];
    const y = uniqueCoordinates[offset + 1];
    const z = uniqueCoordinates[offset + 2];
    const cellX = Math.floor(x / weldToleranceMm);
    const cellY = Math.floor(y / weldToleranceMm);
    const cellZ = Math.floor(z / weldToleranceMm);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const candidates = vertexBuckets.get(`${cellX + dx},${cellY + dy},${cellZ + dz}`);
          if (!candidates) continue;
          for (const candidate of candidates) {
            const candidateOffset = candidate * 3;
            const distanceX = x - uniqueCoordinates[candidateOffset];
            const distanceY = y - uniqueCoordinates[candidateOffset + 1];
            const distanceZ = z - uniqueCoordinates[candidateOffset + 2];
            if (
              distanceX * distanceX + distanceY * distanceY + distanceZ * distanceZ
              <= toleranceSquared
            ) {
              unionVertex(vertex, candidate);
            }
          }
        }
      }
    }

    const ownCell = `${cellX},${cellY},${cellZ}`;
    const bucket = vertexBuckets.get(ownCell);
    if (bucket) bucket.push(vertex);
    else vertexBuckets.set(ownCell, [vertex]);
  }

  const parent = new Int32Array(mesh.triangleCount);
  const rank = new Uint8Array(mesh.triangleCount);
  for (let i = 0; i < parent.length; i++) parent[i] = i;

  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    let rootA = find(a);
    let rootB = find(b);
    if (rootA === rootB) return;
    if (rank[rootA] < rank[rootB]) [rootA, rootB] = [rootB, rootA];
    parent[rootB] = rootA;
    if (rank[rootA] === rank[rootB]) rank[rootA]++;
  };

  const firstTriangleByEdge = new Map<string, number>();
  for (let triangle = 0; triangle < mesh.triangleCount; triangle++) {
    const vertices = [
      findVertex(uniqueIndexByVertex[triangle * 3]),
      findVertex(uniqueIndexByVertex[triangle * 3 + 1]),
      findVertex(uniqueIndexByVertex[triangle * 3 + 2]),
    ];
    const edges: Array<[number, number]> = [[0, 1], [1, 2], [2, 0]];
    for (const [start, end] of edges) {
      if (vertices[start] === vertices[end]) continue;
      const key = edgeKey(vertices[start], vertices[end]);
      const first = firstTriangleByEdge.get(key);
      if (first === undefined) firstTriangleByEdge.set(key, triangle);
      else union(first, triangle);
    }
  }

  const components = new Map<number, number[]>();
  for (let triangle = 0; triangle < mesh.triangleCount; triangle++) {
    const root = find(triangle);
    const indices = components.get(root);
    if (indices) indices.push(triangle);
    else components.set(root, [triangle]);
  }

  return [...components.values()]
    .sort((a, b) => a[0] - b[0])
    .map((triangleIndices) => ({
      triangleIndices,
      mesh: extractMeshTriangles(mesh, triangleIndices),
    }));
}
