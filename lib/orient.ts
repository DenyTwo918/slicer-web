import type { StlMesh } from "./stl";

export interface OrientationResult {
  rx: number;
  ry: number;
  rz: number;
  score: number;
  proj: number;
  comZ: number;
  height: number;
}

export interface MeshStats {
  volume: number; // mm3
  com: [number, number, number];
  width: number;
  depth: number;
  height: number;
}

// ---------------------------------------------------------------- matice 3x3

function mul3(a: number[][], b: number[][]): number[][] {
  const r: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[i][k] * b[k][j];
      r[i][j] = s;
    }
  return r;
}

function rotationMatrix(rx: number, ry: number, rz: number): number[][] {
  const rad = (d: number) => (d * Math.PI) / 180;
  const cx = Math.cos(rad(rx)), sx = Math.sin(rad(rx));
  const cy = Math.cos(rad(ry)), sy = Math.sin(rad(ry));
  const cz = Math.cos(rad(rz)), sz = Math.sin(rad(rz));
  const mx = [
    [1, 0, 0],
    [0, cx, -sx],
    [0, sx, cx],
  ];
  const my = [
    [cy, 0, sy],
    [0, 1, 0],
    [-sy, 0, cy],
  ];
  const mz = [
    [cz, -sz, 0],
    [sz, cz, 0],
    [0, 0, 1],
  ];
  return mul3(mul3(mx, my), mz); // poradi X -> Y -> Z
}

function rotatePoint(p: number[], m: number[][]): number[] {
  return [
    m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2],
    m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2],
    m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2],
  ];
}

/** Vrátí novou mesh otočenou o Eulerovy úhly (stupně). */
export function rotateMesh(
  mesh: StlMesh,
  rx: number,
  ry: number,
  rz: number
): StlMesh {
  const m = rotationMatrix(rx, ry, rz);
  const positions = new Float32Array(mesh.positions.length);
  const normals = new Float32Array(mesh.normals.length);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p = rotatePoint(
      [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]],
      m
    );
    const n = rotatePoint(
      [mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]],
      m
    );
    positions[i] = p[0];
    positions[i + 1] = p[1];
    positions[i + 2] = p[2];
    normals[i] = n[0];
    normals[i + 1] = n[1];
    normals[i + 2] = n[2];
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  }
  return {
    positions,
    normals,
    triangleCount: mesh.triangleCount,
    bounds: {
      min: min as [number, number, number],
      max: max as [number, number, number],
    },
  };
}

// ------------------------------------------------------------- geometrie

function cross(a: number[], b: number[]): number[] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function triAt(pos: Float32Array, i: number): [number[], number[], number[]] {
  const o = i * 9;
  return [
    [pos[o], pos[o + 1], pos[o + 2]],
    [pos[o + 3], pos[o + 4], pos[o + 5]],
    [pos[o + 6], pos[o + 7], pos[o + 8]],
  ];
}

/** Objem (mm3), těžiště a rozměry uzavřené sítě. */
export function meshStats(mesh: StlMesh): MeshStats {
  let vol = 0;
  const comN = [0, 0, 0];
  const { min, max } = mesh.bounds;
  for (let i = 0; i < mesh.triangleCount; i++) {
    const [v0, v1, v2] = triAt(mesh.positions, i);
    const tet = dot(v0, cross(v1, v2)) / 6;
    vol += tet;
    const s0 = v0[0] + v1[0] + v2[0];
    const s1 = v0[1] + v1[1] + v2[1];
    const s2 = v0[2] + v1[2] + v2[2];
    comN[0] += tet * s0;
    comN[1] += tet * s1;
    comN[2] += tet * s2;
  }
  const v = Math.abs(vol);
  const com: [number, number, number] = [
    comN[0] / (4 * v),
    comN[1] / (4 * v),
    comN[2] / (4 * v),
  ];
  return {
    volume: v,
    com,
    width: max[0] - min[0],
    depth: max[1] - min[1],
    height: max[2] - min[2],
  };
}

/** Metriky pro jednu orientaci: plocha podpory, výška těžiště, výška modelu. */
function metrics(
  mesh: StlMesh,
  rx: number,
  ry: number
): { proj: number; comZ: number; height: number } {
  const rv = rotateMesh(mesh, rx, ry, 0);
  let proj = 0;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let vol = 0;
  const comN = [0, 0, 0];
  for (let i = 0; i < rv.triangleCount; i++) {
    const [v0, v1, v2] = triAt(rv.positions, i);
    const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    const areaVec = [0.5 * cross(e1, e2)[0], 0.5 * cross(e1, e2)[1], 0.5 * cross(e1, e2)[2]];
    proj += 0.5 * Math.abs(areaVec[2]);
    const tet = dot(v0, cross(v1, v2)) / 6;
    vol += tet;
    comN[0] += tet * (v0[0] + v1[0] + v2[0]);
    comN[1] += tet * (v0[1] + v1[1] + v2[1]);
    comN[2] += tet * (v0[2] + v1[2] + v2[2]);
    if (v0[2] < minZ) minZ = v0[2];
    if (v1[2] < minZ) minZ = v1[2];
    if (v2[2] < minZ) minZ = v2[2];
    if (v0[2] > maxZ) maxZ = v0[2];
    if (v1[2] > maxZ) maxZ = v1[2];
    if (v2[2] > maxZ) maxZ = v2[2];
  }
  const v = Math.abs(vol);
  const comZ = comN[2] / (4 * v) - minZ;
  return { proj, comZ, height: maxZ - minZ };
}

/**
 * Najde nejlepší orientaci hrubým skenem rotací kolem X a Y.
 * Skóre (nižší = lepší): projekce (podpora) + 0.5·výška těžiště + 0.2·výška.
 * Rotace kolem Z nic nemění (projekce na desku), takže se neskenuje.
 */
export function findBestOrientation(
  mesh: StlMesh,
  step = 15
): OrientationResult {
  const cands: OrientationResult[] = [];
  for (let rx = 0; rx < 180; rx += step) {
    for (let ry = 0; ry < 180; ry += step) {
      const m = metrics(mesh, rx, ry);
      cands.push({ rx, ry, rz: 0, score: 0, ...m });
    }
  }
  const maxProj = Math.max(...cands.map((c) => c.proj)) || 1;
  const maxCom = Math.max(...cands.map((c) => c.comZ)) || 1;
  const maxH = Math.max(...cands.map((c) => c.height)) || 1;
  for (const c of cands) {
    c.score = c.proj / maxProj + 0.5 * (c.comZ / maxCom) + 0.2 * (c.height / maxH);
  }
  return cands.reduce((a, b) => (b.score < a.score ? b : a));
}
