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
