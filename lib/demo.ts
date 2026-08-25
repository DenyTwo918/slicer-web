import type { StlMesh } from "@/lib/stl";

/**
 * Generuje demo model — torus (donut) — čistě parametricky, bez souboru.
 * Hodí se na rychlé vyzkoušení 3D náhledu i slicovacího pipeline.
 */
export function makeTorus(
  R = 30,
  r = 12,
  uSeg = 48,
  vSeg = 24
): StlMesh {
  const triCount = uSeg * vSeg * 2;
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const point = (u: number, v: number): [number, number, number] => [
    (R + r * Math.cos(v)) * Math.cos(u),
    (R + r * Math.cos(v)) * Math.sin(u),
    r * Math.sin(v),
  ];
  const normal = (u: number, v: number): [number, number, number] => [
    Math.cos(u) * Math.cos(v),
    Math.sin(u) * Math.cos(v),
    Math.sin(v),
  ];

  let idx = 0;
  for (let i = 0; i < uSeg; i++) {
    for (let j = 0; j < vSeg; j++) {
      const u0 = (i / uSeg) * Math.PI * 2;
      const u1 = ((i + 1) / uSeg) * Math.PI * 2;
      const v0 = (j / vSeg) * Math.PI * 2;
      const v1 = ((j + 1) / vSeg) * Math.PI * 2;
      // čtverec ze 4 bodů -> 2 trojúhelníky (0,1,2 a 0,2,3)
      const quad = [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ];
      for (const tri of [
        [quad[0], quad[1], quad[2]],
        [quad[0], quad[2], quad[3]],
      ]) {
        for (const [u, v] of tri) {
          const pv = point(u, v);
          const nv = normal(u, v);
          positions[idx * 3] = pv[0];
          positions[idx * 3 + 1] = pv[1];
          positions[idx * 3 + 2] = pv[2];
          normals[idx * 3] = nv[0];
          normals[idx * 3 + 1] = nv[1];
          normals[idx * 3 + 2] = nv[2];
          for (let k = 0; k < 3; k++) {
            if (pv[k] < min[k]) min[k] = pv[k];
            if (pv[k] > max[k]) max[k] = pv[k];
          }
          idx++;
        }
      }
    }
  }

  return {
    positions,
    normals,
    triangleCount: triCount,
    bounds: { min, max },
  };
}

/**
 * Testovací kvádr (krychle) postavený na desce — ideální na čisté
 * vyzkoušení slicování a exportu .pm7.
 */
export function makeBox(size = 40, height = 60): StlMesh {
  const s = size / 2;
  const corners: [number, number, number][] = [
    [-s, -s, 0], [s, -s, 0], [s, s, 0], [-s, s, 0],
    [-s, -s, height], [s, -s, height], [s, s, height], [-s, s, height],
  ];
  const faces: [number, number, number][] = [
    [0, 2, 1], [0, 3, 2], // dno
    [4, 5, 6], [4, 6, 7], // viko
    [0, 1, 5], [0, 5, 4], // přední
    [1, 2, 6], [1, 6, 5], // pravá
    [2, 3, 7], [2, 7, 6], // zadní
    [3, 0, 4], [3, 4, 7], // levá
  ];

  const positions = new Float32Array(faces.length * 9);
  const normals = new Float32Array(faces.length * 9);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  faces.forEach((f, i) => {
    const v0 = corners[f[0]];
    const v1 = corners[f[1]];
    const v2 = corners[f[2]];
    const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
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
    triangleCount: faces.length,
    bounds: { min, max },
  };
}
