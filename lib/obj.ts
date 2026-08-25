import type { StlMesh } from "./stl";

/**
 * Parser OBJ (v/f + triangulace). Normály se přepočítají z vrcholů.
 */
export function parseObj(text: string): StlMesh {
  const verts: number[][] = [];
  const tris: number[][] = [];
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (!p[0]) continue;
    if (p[0] === "v" && p.length >= 4) {
      verts.push([parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])]);
    } else if (p[0] === "f" && p.length >= 4) {
      const ids = p
        .slice(1)
        .map((x) => Math.abs(parseInt(x.split("/")[0], 10)) - 1)
        .filter((i) => i >= 0 && i < verts.length);
      if (ids.length >= 3) {
        for (let i = 1; i < ids.length - 1; i++) {
          tris.push([ids[0], ids[i], ids[i + 1]]);
        }
      }
    }
  }
  if (verts.length === 0 || tris.length === 0) {
    throw new Error("Soubor OBJ neobsahuje žádné vrcholy/trojúhelníky.");
  }

  const positions = new Float32Array(tris.length * 9);
  const normals = new Float32Array(tris.length * 9);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];

  tris.forEach((tri, i) => {
    const v0 = verts[tri[0]];
    const v1 = verts[tri[1]];
    const v2 = verts[tri[2]];
    const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    const n = cross(e1, e2);
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const p = i * 9;
    for (let k = 0; k < 3; k++) {
      const v = k === 0 ? v0 : k === 1 ? v1 : v2;
      positions[p + k * 3] = v[0];
      positions[p + k * 3 + 1] = v[1];
      positions[p + k * 3 + 2] = v[2];
      normals[p + k * 3] = n[0] / len;
      normals[p + k * 3 + 1] = n[1] / len;
      normals[p + k * 3 + 2] = n[2] / len;
    }
    for (const v of [v0, v1, v2]) {
      for (let k = 0; k < 3; k++) {
        if (v[k] < min[k]) min[k] = v[k];
        if (v[k] > max[k]) max[k] = v[k];
      }
    }
  });

  return {
    positions,
    normals,
    triangleCount: tris.length,
    bounds: { min, max },
  };
}
