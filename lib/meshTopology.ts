import type { StlMesh } from "./stl";

export const DEFAULT_WELD_TOLERANCE_MM = 1e-5;

export interface MeshTopologyOptions {
  weldToleranceMm?: number;
}

export interface DirectedEdgeUse {
  triangleIndex: number;
  startVertex: number;
  endVertex: number;
}

export interface TopologyEdge {
  vertices: [number, number];
  uses: DirectedEdgeUse[];
}

export interface MeshTopology {
  /** Kompaktní svařený vertex ID pro každý výskyt vrcholu (3 na trojúhelník). */
  weldedVertexByOccurrence: Int32Array;
  /** XYZ reprezentanta pro každý kompaktní svařený vertex ID. */
  representativePositions: Float32Array;
  edges: TopologyEdge[];
  triangleNeighbors: number[][];
  /** Komponenty spojené skutečně sdílenou hranou, stabilně podle indexu trojúhelníku. */
  shells: number[][];
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function buildMeshTopology(
  mesh: StlMesh,
  options: MeshTopologyOptions = {},
): MeshTopology {
  const tolerance = options.weldToleranceMm ?? DEFAULT_WELD_TOLERANCE_MM;
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new Error("Tolerance spojování musí být kladné konečné číslo.");
  }

  const occurrenceCount = mesh.triangleCount * 3;
  if (mesh.positions.length !== occurrenceCount * 3) {
    throw new Error("Mesh má neplatný počet souřadnic trojúhelníků.");
  }
  if (occurrenceCount === 0) {
    return {
      weldedVertexByOccurrence: new Int32Array(),
      representativePositions: new Float32Array(),
      edges: [],
      triangleNeighbors: [],
      shells: [],
    };
  }

  // Přesné duplicity nejdřív zredukujeme. U STL tím výrazně zmenšíme prostorový hash.
  const uniqueIndexByCoordinate = new Map<string, number>();
  const uniqueCoordinates: number[] = [];
  const uniqueIndexByOccurrence = new Int32Array(occurrenceCount);
  for (let occurrence = 0; occurrence < occurrenceCount; occurrence++) {
    const offset = occurrence * 3;
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
    uniqueIndexByOccurrence[occurrence] = uniqueIndex;
  }

  const uniqueCount = uniqueCoordinates.length / 3;
  const clusterByUniqueVertex = new Int32Array(uniqueCount);
  clusterByUniqueVertex.fill(-1);
  const clusterMembers: number[][] = [];
  const buckets = new Map<string, number[]>();
  const toleranceSquared = tolerance * tolerance;

  const fitsCluster = (vertex: number, cluster: number): boolean => {
    const offset = vertex * 3;
    for (const member of clusterMembers[cluster]) {
      const memberOffset = member * 3;
      const diffX = uniqueCoordinates[offset] - uniqueCoordinates[memberOffset];
      const diffY = uniqueCoordinates[offset + 1] - uniqueCoordinates[memberOffset + 1];
      const diffZ = uniqueCoordinates[offset + 2] - uniqueCoordinates[memberOffset + 2];
      if (diffX * diffX + diffY * diffY + diffZ * diffZ > toleranceSquared) return false;
    }
    return true;
  };

  for (let vertex = 0; vertex < uniqueCount; vertex++) {
    const offset = vertex * 3;
    const x = uniqueCoordinates[offset];
    const y = uniqueCoordinates[offset + 1];
    const z = uniqueCoordinates[offset + 2];
    const cellX = Math.floor(x / tolerance);
    const cellY = Math.floor(y / tolerance);
    const cellZ = Math.floor(z / tolerance);

    let selectedCluster = -1;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const candidates = buckets.get(`${cellX + dx},${cellY + dy},${cellZ + dz}`);
          if (!candidates) continue;
          for (const cluster of candidates) {
            if ((selectedCluster === -1 || cluster < selectedCluster) && fitsCluster(vertex, cluster)) {
              selectedCluster = cluster;
            }
          }
        }
      }
    }

    if (selectedCluster === -1) {
      selectedCluster = clusterMembers.length;
      clusterMembers.push([vertex]);
      const ownCell = `${cellX},${cellY},${cellZ}`;
      const bucket = buckets.get(ownCell);
      if (bucket) bucket.push(selectedCluster);
      else buckets.set(ownCell, [selectedCluster]);
    } else {
      clusterMembers[selectedCluster].push(vertex);
    }
    clusterByUniqueVertex[vertex] = selectedCluster;
  }

  // Compact IDs follow first occurrence and every cluster has a true <= tolerance diameter.
  const compactByCluster = new Map<number, number>();
  const representativeCoordinates: number[] = [];
  const weldedVertexByOccurrence = new Int32Array(occurrenceCount);
  for (let occurrence = 0; occurrence < occurrenceCount; occurrence++) {
    const uniqueIndex = uniqueIndexByOccurrence[occurrence];
    const cluster = clusterByUniqueVertex[uniqueIndex];
    let compact = compactByCluster.get(cluster);
    if (compact === undefined) {
      compact = compactByCluster.size;
      compactByCluster.set(cluster, compact);
      const offset = clusterMembers[cluster][0] * 3;
      representativeCoordinates.push(
        uniqueCoordinates[offset],
        uniqueCoordinates[offset + 1],
        uniqueCoordinates[offset + 2],
      );
    }
    weldedVertexByOccurrence[occurrence] = compact;
  }

  const edgeByKey = new Map<string, TopologyEdge>();
  for (let triangle = 0; triangle < mesh.triangleCount; triangle++) {
    const base = triangle * 3;
    const vertices = [
      weldedVertexByOccurrence[base],
      weldedVertexByOccurrence[base + 1],
      weldedVertexByOccurrence[base + 2],
    ];
    for (const [start, end] of [[0, 1], [1, 2], [2, 0]] as const) {
      const startVertex = vertices[start];
      const endVertex = vertices[end];
      if (startVertex === endVertex) continue;
      const key = edgeKey(startVertex, endVertex);
      let edge = edgeByKey.get(key);
      if (!edge) {
        edge = {
          vertices: startVertex < endVertex
            ? [startVertex, endVertex]
            : [endVertex, startVertex],
          uses: [],
        };
        edgeByKey.set(key, edge);
      }
      edge.uses.push({ triangleIndex: triangle, startVertex, endVertex });
    }
  }

  const edges = [...edgeByKey.values()].sort((a, b) =>
    a.vertices[0] - b.vertices[0] || a.vertices[1] - b.vertices[1]
  );
  const neighborSets = Array.from({ length: mesh.triangleCount }, () => new Set<number>());
  for (const edge of edges) {
    for (let i = 0; i < edge.uses.length; i++) {
      for (let j = i + 1; j < edge.uses.length; j++) {
        const a = edge.uses[i].triangleIndex;
        const b = edge.uses[j].triangleIndex;
        if (a === b) continue;
        neighborSets[a].add(b);
        neighborSets[b].add(a);
      }
    }
  }
  const triangleNeighbors = neighborSets.map((set) => [...set].sort((a, b) => a - b));

  const visited = new Uint8Array(mesh.triangleCount);
  const shells: number[][] = [];
  for (let first = 0; first < mesh.triangleCount; first++) {
    if (visited[first]) continue;
    const queue = [first];
    visited[first] = 1;
    const shell: number[] = [];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const triangle = queue[cursor];
      shell.push(triangle);
      for (const neighbor of triangleNeighbors[triangle]) {
        if (visited[neighbor]) continue;
        visited[neighbor] = 1;
        queue.push(neighbor);
      }
    }
    shell.sort((a, b) => a - b);
    shells.push(shell);
  }

  return {
    weldedVertexByOccurrence,
    representativePositions: new Float32Array(representativeCoordinates),
    edges,
    triangleNeighbors,
    shells,
  };
}
