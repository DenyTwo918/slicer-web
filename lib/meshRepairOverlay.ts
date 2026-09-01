import * as THREE from "three";
import type { MeshIssueSample } from "./meshRepair";
import type { StlMesh } from "./stl";

export interface MeshRepairOverlayGeometry {
  triangles: THREE.BufferGeometry | null;
  edges: THREE.BufferGeometry | null;
}

const EDGE_KINDS = new Set([
  "boundary-edge",
  "non-manifold-edge",
  "inconsistent-winding",
]);

function translatePositions(
  positions: Float32Array,
  mesh: StlMesh,
  geometryOffset: { x: number; y: number },
): void {
  for (let offset = 0; offset < positions.length; offset += 3) {
    positions[offset] += geometryOffset.x;
    positions[offset + 1] += geometryOffset.y;
    positions[offset + 2] -= mesh.bounds.min[2];
  }
}

export function buildMeshRepairOverlay(
  mesh: StlMesh,
  sample: MeshIssueSample,
  geometryOffset: { x: number; y: number },
): MeshRepairOverlayGeometry {
  if (EDGE_KINDS.has(sample.kind)) {
    if (!sample.edgePoints) throw new Error("Vzorek hrany nemá souřadnice pro overlay.");
    const positions = new Float32Array([
      ...sample.edgePoints[0],
      ...sample.edgePoints[1],
    ]);
    translatePositions(positions, mesh, geometryOffset);
    const edges = new THREE.BufferGeometry();
    edges.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    edges.computeBoundingSphere();
    return { triangles: null, edges };
  }

  const positions = new Float32Array(sample.triangleIndices.length * 9);
  sample.triangleIndices.forEach((triangleIndex, outputIndex) => {
    if (!Number.isInteger(triangleIndex) || triangleIndex < 0 || triangleIndex >= mesh.triangleCount) {
      throw new Error(`Neplatný index trojúhelníku pro overlay: ${triangleIndex}.`);
    }
    const sourceOffset = triangleIndex * 9;
    positions.set(mesh.positions.subarray(sourceOffset, sourceOffset + 9), outputIndex * 9);
  });
  translatePositions(positions, mesh, geometryOffset);
  const triangles = new THREE.BufferGeometry();
  triangles.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  triangles.computeVertexNormals();
  triangles.computeBoundingSphere();
  return { triangles, edges: null };
}
