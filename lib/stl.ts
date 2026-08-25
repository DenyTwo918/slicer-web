export interface StlBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface StlMesh {
  /** 9 floatů na trojúhelník (3 vrcholy × 3 souřadnice) */
  positions: Float32Array;
  normals: Float32Array;
  triangleCount: number;
  bounds: StlBounds;
}

function cross(a: number[], b: number[]): number[] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v: number[]): number[] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function makeMesh(triVerts: number[][][], triCount: number): StlMesh {
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < triCount; i++) {
    const [v0, v1, v2] = triVerts[i];
    const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    const n = normalize(cross(e1, e2));

    const p = i * 9;
    positions[p] = v0[0]; positions[p + 1] = v0[1]; positions[p + 2] = v0[2];
    positions[p + 3] = v1[0]; positions[p + 4] = v1[1]; positions[p + 5] = v1[2];
    positions[p + 6] = v2[0]; positions[p + 7] = v2[1]; positions[p + 8] = v2[2];
    for (let k = 0; k < 3; k++) {
      normals[p + k] = n[k];
      normals[p + 3 + k] = n[k];
      normals[p + 6 + k] = n[k];
    }

    for (const v of [v0, v1, v2]) {
      for (let k = 0; k < 3; k++) {
        if (v[k] < min[k]) min[k] = v[k];
        if (v[k] > max[k]) max[k] = v[k];
      }
    }
  }

  return { positions, normals, triangleCount: triCount, bounds: { min, max } };
}

/**
 * Parser binárního STL (80 B hlavička, uint32 počet trojúhelníků,
 * každý trojúhelník: normala 12 B + 3 vrcholy 36 B + atribut 2 B).
 * Normály se přepočítají z vrcholů. Toleruje i soubory s přebytečnými
 * bajty na konci (některé nástroje je přidávají).
 */
export function parseBinaryStl(buffer: ArrayBuffer): StlMesh {
  if (buffer.byteLength < 84) {
    throw new Error("Soubor je příliš malý – není to binární STL.");
  }
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  const needed = 84 + count * 50;
  if (buffer.byteLength < needed) {
    throw new Error("STL má neočekávanou velikost – zkusím textový formát.");
  }

  const triVerts: number[][][] = [];
  for (let i = 0; i < count; i++) {
    const off = 84 + i * 50;
    triVerts.push([
      [
        view.getFloat32(off + 12, true),
        view.getFloat32(off + 16, true),
        view.getFloat32(off + 20, true),
      ],
      [
        view.getFloat32(off + 24, true),
        view.getFloat32(off + 28, true),
        view.getFloat32(off + 32, true),
      ],
      [
        view.getFloat32(off + 36, true),
        view.getFloat32(off + 40, true),
        view.getFloat32(off + 44, true),
      ],
    ]);
  }
  return makeMesh(triVerts, count);
}

/**
 * Parser textového (ASCII) STL — soubory začínající "solid" s řádky
 * "facet normal" / "vertex x y z". Normály se přepočítají z vrcholů.
 */
export function parseAsciiStl(text: string): StlMesh {
  const vertexRe = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  const verts: number[][] = [];
  let m: RegExpExecArray | null;
  while ((m = vertexRe.exec(text)) !== null) {
    verts.push([
      parseFloat(m[1]),
      parseFloat(m[2]),
      parseFloat(m[3]),
    ]);
  }

  if (verts.length === 0 || verts.length % 3 !== 0) {
    throw new Error("Textový STL nemá kompletní trojúhelníky (vrstvy vrcholů).");
  }

  const triVerts: number[][][] = [];
  for (let i = 0; i < verts.length; i += 3) {
    triVerts.push([verts[i], verts[i + 1], verts[i + 2]]);
  }
  return makeMesh(triVerts, triVerts.length);
}

/**
 * Načte STL — automaticky pozná binární i textový formát.
 */
export function parseStl(buffer: ArrayBuffer): StlMesh {
  // 1) zkus binární
  try {
    return parseBinaryStl(buffer);
  } catch {
    // 2) jinak textový (ASCII)
  }
  const text = new TextDecoder("latin1").decode(buffer);
  if (/\bvertex\b/i.test(text) || /^\s*solid\b/i.test(text)) {
    return parseAsciiStl(text);
  }
  throw new Error(
    "Nepodařilo se načíst STL – soubor není binární ani textový STL. " +
      "Zkus exportovat model jako STL (trojúhelníková síť), případně OBJ."
  );
}
