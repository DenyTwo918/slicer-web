import type { StlMesh } from "./stl";
import { rotateMesh as rotateOrient } from "./orient";

export interface ModelTransform {
  /** pozice na desce (mm) — z=0 je deska */
  x: number;
  y: number;
  z: number;
  /** rotace ve stupních */
  rx: number;
  ry: number;
  rz: number;
  /** měřítko (1 = 100 %) */
  scale: number;
}

export const DEFAULT_TRANSFORM: ModelTransform = {
  x: 0,
  y: 0,
  z: 0,
  rx: 0,
  ry: 0,
  rz: 0,
  scale: 1,
};

export function translateMesh(mesh: StlMesh, x: number, y: number, z: number): StlMesh {
  if (x === 0 && y === 0 && z === 0) return mesh;
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    positions[i] = mesh.positions[i] + x;
    positions[i + 1] = mesh.positions[i + 1] + y;
    positions[i + 2] = mesh.positions[i + 2] + z;
  }
  const min: [number, number, number] = [
    mesh.bounds.min[0] + x,
    mesh.bounds.min[1] + y,
    mesh.bounds.min[2] + z,
  ];
  const max: [number, number, number] = [
    mesh.bounds.max[0] + x,
    mesh.bounds.max[1] + y,
    mesh.bounds.max[2] + z,
  ];
  return { ...mesh, positions, bounds: { min, max } };
}

export function scaleMesh(mesh: StlMesh, s: number): StlMesh {
  if (s === 1) return mesh;
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i++) {
    positions[i] = mesh.positions[i] * s;
  }
  const min: [number, number, number] = [
    mesh.bounds.min[0] * s,
    mesh.bounds.min[1] * s,
    mesh.bounds.min[2] * s,
  ];
  const max: [number, number, number] = [
    mesh.bounds.max[0] * s,
    mesh.bounds.max[1] * s,
    mesh.bounds.max[2] * s,
  ];
  return { ...mesh, positions, bounds: { min, max } };
}

/** Otočí mesh o Eulerovy úhly (stupně) — deleguje na orient.rotateMesh. */
export function rotateMesh(mesh: StlMesh, rx: number, ry: number, rz: number): StlMesh {
  return rotateOrient(mesh, rx, ry, rz);
}

/** Zrcadlení meshe podle osy (normaly se přepočítají). */
export function mirrorMesh(mesh: StlMesh, axis: "x" | "y" | "z"): StlMesh {
  const idx = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  const positions = new Float32Array(mesh.positions.length);
  const normals = new Float32Array(mesh.normals.length);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const s = k === idx ? -1 : 1;
      positions[i + k] = mesh.positions[i + k] * s;
      normals[i + k] = mesh.normals[i + k] * s;
      if (positions[i + k] < min[k]) min[k] = positions[i + k];
      if (positions[i + k] > max[k]) max[k] = positions[i + k];
    }
  }
  return { ...mesh, positions, normals, bounds: { min, max } };
}

/** Aplikuje celý transform na data meshe (pro slicování/export). */
export function applyTransform(mesh: StlMesh, t: ModelTransform): StlMesh {
  let m = mesh;
  if (t.scale !== 1) m = scaleMesh(m, t.scale);
  if (t.rx !== 0 || t.ry !== 0 || t.rz !== 0) m = rotateMesh(m, t.rx, t.ry, t.rz);
  if (t.x !== 0 || t.y !== 0 || t.z !== 0) m = translateMesh(m, t.x, t.y, t.z);
  return m;
}

/** Sjednotí bounding boxy více meshes (pro scene.slice). */
export function unionBounds(
  meshes: StlMesh[]
): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    for (let k = 0; k < 3; k++) {
      if (m.bounds.min[k] < min[k]) min[k] = m.bounds.min[k];
      if (m.bounds.max[k] > max[k]) max[k] = m.bounds.max[k];
    }
  }
  return { min, max };
}

/** Součet objemů meshes (mm3) — pro print_info. */
export function totalVolume(meshes: StlMesh[]): number {
  let vol = 0;
  for (const mesh of meshes) {
    const p = mesh.positions;
    let v = 0;
    for (let t = 0; t < mesh.triangleCount; t++) {
      const o = t * 9;
      const v0 = [p[o], p[o + 1], p[o + 2]];
      const v1 = [p[o + 3], p[o + 4], p[o + 5]];
      const v2 = [p[o + 6], p[o + 7], p[o + 8]];
      const cx = v0[1] * v1[2] - v0[2] * v1[1];
      const cy = v0[2] * v1[0] - v0[0] * v1[2];
      const cz = v0[0] * v1[1] - v0[1] * v1[0];
      v += v0[0] * cx + v0[1] * cy + v0[2] * cz;
    }
    vol += Math.abs(v) / 6;
  }
  return vol;
}

/** Vejde se model (po transformaci) do tiskové vany? (mm) */
export function fitsInVat(
  mesh: StlMesh,
  t: ModelTransform,
  vat: { x: number; y: number; z: number }
): boolean {
  const m = applyTransform(mesh, t);
  const { min, max } = m.bounds;
  return (
    min[0] >= -vat.x / 2 &&
    max[0] <= vat.x / 2 &&
    min[1] >= -vat.y / 2 &&
    max[1] <= vat.y / 2 &&
    min[2] >= 0 &&
    max[2] <= vat.z
  );
}

/** Posune mesh tak, aby stála na desce (minZ = 0). */
export function normalizeToPlate(mesh: StlMesh): StlMesh {
  const shift = mesh.bounds.min[2];
  return shift === 0 ? mesh : translateMesh(mesh, 0, 0, -shift);
}
