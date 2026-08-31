import type { StlMesh } from "./stl";
import { buildMeshTopology, DEFAULT_WELD_TOLERANCE_MM } from "./meshTopology";

export interface MeshShell {
  mesh: StlMesh;
  /** Indexy trojúhelníků v původním modelu, ve stabilním pořadí. */
  triangleIndices: number[];
}

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

  const topology = buildMeshTopology(mesh, { weldToleranceMm });
  return topology.shells.map((triangleIndices) => ({
      triangleIndices,
      mesh: extractMeshTriangles(mesh, triangleIndices),
  }));
}
