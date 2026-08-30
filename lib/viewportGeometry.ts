import * as THREE from "three";
import type { StlMesh } from "./stl";

/**
 * Builds the render-only geometry at an explicit immutable boundary.
 * Three.js mutates BufferAttribute arrays when geometry transforms run, so the
 * viewport must never attach the slicer's source arrays directly.
 */
export function buildViewportModelGeometry(
  mesh: StlMesh,
  geometryOffset: { x: number; y: number },
): THREE.BufferGeometry {
  const positions = new Float32Array(mesh.positions);
  const normals = new Float32Array(mesh.normals);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.translate(geometryOffset.x, geometryOffset.y, -mesh.bounds.min[2]);
  geometry.computeBoundingSphere();
  return geometry;
}
