import * as THREE from "three";
import type { MeshIssueSample } from "./meshRepair";
import type { StlMesh } from "./stl";

export interface MeshRepairOverlayGeometry {
  triangles: THREE.BufferGeometry | null;
  edges: THREE.BufferGeometry | null;
  markers: THREE.BufferGeometry | null;
}

function geometryFromPositions(positions: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
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
    return {
      triangles: null,
      edges: geometryFromPositions(positions),
      markers: geometryFromPositions(positions.slice()),
    };
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

  if (sample.kind === "degenerate-triangle") {
    const edgePositions = new Float32Array(sample.triangleIndices.length * 18);
    const markerPositions = new Float32Array(sample.triangleIndices.length * 3);
    for (let triangle = 0; triangle < sample.triangleIndices.length; triangle++) {
      const base = triangle * 9;
      const edgeBase = triangle * 18;
      edgePositions.set(positions.subarray(base, base + 6), edgeBase);
      edgePositions.set(positions.subarray(base + 3, base + 9), edgeBase + 6);
      edgePositions.set(positions.subarray(base + 6, base + 9), edgeBase + 12);
      edgePositions.set(positions.subarray(base, base + 3), edgeBase + 15);
      for (let axis = 0; axis < 3; axis++) {
        markerPositions[triangle * 3 + axis] = (
          positions[base + axis]
          + positions[base + 3 + axis]
          + positions[base + 6 + axis]
        ) / 3;
      }
    }
    return {
      triangles: null,
      edges: geometryFromPositions(edgePositions),
      markers: geometryFromPositions(markerPositions),
    };
  }

  const triangles = new THREE.BufferGeometry();
  triangles.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  triangles.computeVertexNormals();
  triangles.computeBoundingSphere();
  return { triangles, edges: null, markers: null };
}
