import type { SliceResult } from "./slice";
import type { PipelineModel } from "./pipeline";
import { nativeReady, uploadDepth, fillBetweenZ } from "./native";

/**
 * GPU slicing — WebGPU depth-based přístup.
 *
 * Místo protínání trojúhelníků rovinou (O(trojúhelníky × vrstvy) na CPU)
 * se mesh dvakrát vyrenderuje ortograficky podél Z (celý model, 2 průchody):
 *   1) depthCompare "less"    → nejbližší povrch (vstup do materiálu)
 *   2) depthCompare "greater" → nejvzdálenější povrch (výstup z materiálu)
 * Pro každou vrstvu z pak platí: solid = front < z < back (u hollow se stěny
 * posunou dovnitř o tloušťku stěny — zdarma, přesně, bez morfologie).
 *
 * Požadavky: WebGPU (Chrome/Edge 113+) v workeru. Pokud není k dispozici,
 * vrací null → pipeline použije CPU sliceMesh.
 *
 * Omezení: předpokládá uzavřený (watertight) mesh s jedním souvislým
 * intervalem na paprsek — pro běžné SLA modely to platí.
 */

type AnyDev = any;

// WebGPU bitové flagy (chybí @webgpu/types v projektu)
const BUFFER_USAGE = { VERTEX: 0x80, UNIFORM: 0x40, COPY_DST: 0x8, COPY_SRC: 0x4, MAP_READ: 0x1 };
const TEXTURE_USAGE = { RENDER_ATTACHMENT: 0x10, COPY_SRC: 0x4 };
const SHADER_STAGE = { VERTEX: 0x1 };
const MAP_MODE = { READ: 0x1 };

let device: AnyDev | null = null;

async function getDevice(): Promise<AnyDev | null> {
  if (device) return device;
  try {
    const gpu = (navigator as unknown as { gpu?: AnyDev }).gpu;
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    device = await adapter.requestDevice();
    return device;
  } catch {
    return null;
  }
}

const WGSL = `
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) z: f32,
};
struct Uniforms { resX: f32, resY: f32, zMin: f32, zRange: f32 };
@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vs(@location(0) px: vec3f) -> VOut {
  let ndc = vec2f(px.x / u.resX * 2.0 - 1.0, 1.0 - px.y / u.resY * 2.0);
  let zN = (px.z - u.zMin) / u.zRange;
  return VOut(vec4f(ndc, zN, 1.0), zN);
}

@fragment
fn fs(in: VOut) -> @builtin(frag_depth) f32 {
  return in.z;
}
`;

interface GpuSliceParams {
  models: PipelineModel[];
  layerHeight: number;
  hollow: boolean;
  wallMm: number;
  drainHoles: boolean;
  holeDiaMm: number;
  printer: { resX: number; resY: number; printX: number; printY: number };
}

/** Vyřízne kruhový otvor na pravém okraji vrstvy (odvod pryskyřice). */
function carveEdgeHole(layer: Uint8Array, holeR: number, W: number, H: number) {
  let mx = -1;
  let my = -1;
  for (let y = 0; y < H; y++) {
    for (let x = W - 1; x >= 0; x--) {
      if (layer[y * W + x]) {
        if (x > mx) {
          mx = x;
          my = y;
        }
        break;
      }
    }
  }
  if (mx >= 0) {
    const r2 = holeR * holeR;
    const x0 = Math.max(0, mx - holeR);
    const x1 = Math.min(W - 1, mx + holeR);
    const y0 = Math.max(0, my - holeR);
    const y1 = Math.min(H - 1, my + holeR);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - mx;
        const dy = y - my;
        if (dx * dx + dy * dy <= r2) layer[y * W + x] = 0;
      }
    }
  }
}

/**
 * GPU depth slicing. Vrací SliceResult (vrstvy 0/1, hollow už aplikováno)
 * nebo null, když WebGPU není dostupné.
 */
export async function gpuSlice(params: GpuSliceParams): Promise<SliceResult | null> {
  try {
    return await gpuSliceInner(params);
  } catch {
    // jakákoli chyba WebGPU → CPU fallback (žádný pád pipeline)
    return null;
  }
}

async function gpuSliceInner(params: GpuSliceParams): Promise<SliceResult | null> {
  if (typeof navigator === "undefined") return null;
  const dev = await getDevice();
  if (!dev) return null;
  const { models, layerHeight, printer } = params;
  if (models.length === 0) return null;

  const scale = printer.resX % 16 === 0 && printer.resY % 16 === 0 ? 16 : 1;
  const W = printer.resX / scale;
  const H = printer.resY / scale;
  const pxPerMmX = W / printer.printX;
  const pxPerMmY = H / printer.printY;

  let zMin = Infinity;
  let zMax = -Infinity;
  for (const m of models) {
    zMin = Math.min(zMin, m.bounds.min[2]);
    zMax = Math.max(zMax, m.bounds.max[2]);
  }
  const zRange = Math.max(zMax - zMin, 1e-6);
  const numLayers = Math.max(1, Math.floor(zRange / layerHeight));

  // --- vertex buffer: bake pixelové souřadnice + posun modelu (1 buffer = union všech) ---
  let totalVerts = 0;
  for (const m of models) totalVerts += m.triangleCount * 3;
  const verts = new Float32Array(totalVerts * 3);
  let vi = 0;
  for (const m of models) {
    const cx = (printer.printX - (m.bounds.max[0] - m.bounds.min[0])) / 2 - m.bounds.min[0];
    const cy = (printer.printY - (m.bounds.max[1] - m.bounds.min[1])) / 2 - m.bounds.min[1];
    const ox = cx + m.tx; // mm
    const oy = cy + m.ty; // mm
    const pos = m.positions;
    for (let k = 0; k < m.triangleCount * 9; k += 9) {
      for (let v = 0; v < 3; v++) {
        verts[vi++] = (pos[k + v * 3] + ox) * pxPerMmX; // px.x
        verts[vi++] = (pos[k + v * 3 + 1] + oy) * pxPerMmY; // px.y
        verts[vi++] = pos[k + v * 3 + 2]; // z v mm
      }
    }
  }

  const vb = dev.createBuffer({
    size: verts.byteLength,
    usage: BUFFER_USAGE.VERTEX,
    mappedAtCreation: true,
  });
  new Float32Array(vb.getMappedRange()).set(verts);
  vb.unmap();

  const ub = dev.createBuffer({
    size: 16,
    usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
  });
  dev.queue.writeBuffer(ub, 0, new Float32Array([W, H, zMin, zRange]));

  const module = dev.createShaderModule({ code: WGSL });
  const bgl = dev.createBindGroupLayout({
    entries: [{ binding: 0, visibility: SHADER_STAGE.VERTEX, buffer: { type: "uniform" } }],
  });
  const pll = dev.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const bg = dev.createBindGroup({
    layout: bgl,
    entries: [{ binding: 0, resource: { buffer: ub } }],
  });

  const makePipeline = (compare: string) =>
    dev.createRenderPipeline({
      layout: pll,
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 12,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
          },
        ],
      },
      fragment: { module, entryPoint: "fs", targets: [] },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: compare,
      },
    });
  const pipeFront = makePipeline("less");
  const pipeBack = makePipeline("greater");

  const makeDepthTex = () =>
    dev.createTexture({
      size: { width: W, height: H },
      format: "depth32float",
      usage: TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.COPY_SRC,
    });
  const texFront = makeDepthTex();
  const texBack = makeDepthTex();

  // readback buffery (bytesPerRow musí být násobek 256)
  const rowBytes = 4 * W;
  const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
  const readbackSize = bytesPerRow * H;
  const rbFront = dev.createBuffer({ size: readbackSize, usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.MAP_READ });
  const rbBack = dev.createBuffer({ size: readbackSize, usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.MAP_READ });

  const enc = dev.createCommandEncoder();
  const passFront = enc.beginRenderPass({
    colorAttachments: [],
    depthStencilAttachment: {
      view: texFront.createView(),
      depthClearValue: 1.0,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
  });
  passFront.setPipeline(pipeFront);
  passFront.setBindGroup(0, bg);
  passFront.setVertexBuffer(0, vb);
  passFront.draw(totalVerts);
  passFront.end();

  const passBack = enc.beginRenderPass({
    colorAttachments: [],
    depthStencilAttachment: {
      view: texBack.createView(),
      depthClearValue: 0.0,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
  });
  passBack.setPipeline(pipeBack);
  passBack.setBindGroup(0, bg);
  passBack.setVertexBuffer(0, vb);
  passBack.draw(totalVerts);
  passBack.end();

  enc.copyTextureToBuffer(
    { texture: texFront, mipLevel: 0, origin: { x: 0, y: 0 } },
    { buffer: rbFront, bytesPerRow, rowsPerImage: H },
    { width: W, height: H, depthOrArrayLayers: 1 }
  );
  enc.copyTextureToBuffer(
    { texture: texBack, mipLevel: 0, origin: { x: 0, y: 0 } },
    { buffer: rbBack, bytesPerRow, rowsPerImage: H },
    { width: W, height: H, depthOrArrayLayers: 1 }
  );
  dev.queue.submit([enc.finish()]);

  const mapBoth = async () => {
    await rbFront.mapAsync(MAP_MODE.READ);
    await rbBack.mapAsync(MAP_MODE.READ);
    const fr = new Float32Array(rbFront.getMappedRange().slice(0, readbackSize));
    const ba = new Float32Array(rbBack.getMappedRange().slice(0, readbackSize));
    const front = new Float32Array(W * H);
    const back = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const src = (y * bytesPerRow) / 4;
      front.set(fr.subarray(src, src + W), y * W);
      back.set(ba.subarray(src, src + W), y * W);
    }
    rbFront.unmap();
    rbBack.unmap();
    // normalizované hloubky (0..1) → mm
    for (let i = 0; i < front.length; i++) {
      front[i] = zMin + front[i] * zRange;
      back[i] = zMin + back[i] * zRange;
    }
    return { front, back };
  };
  const { front, back } = await mapBoth();

  // sanity check: pokud se render neprovedl (front >= back všude), spadnout na CPU
  let valid = 0;
  for (let i = 0; i < front.length; i++) if (front[i] < back[i]) valid++;
  if (valid < Math.max(1, front.length * 0.01)) return null;

  // --- plnění vrstev (WASM fill_between; depth mapy nahrané jednou) ---
  const layers: SliceResult["layers"] = [];
  const n = W * H;
  if (nativeReady()) {
    uploadDepth(front, back, n);
    const wallMm = params.hollow ? Math.max(params.wallMm, 0) : 0;
    const solidBase = params.hollow ? Math.max(1, Math.floor(numLayers * 0.02)) : 0;
    const holeR = params.drainHoles ? Math.max(1, Math.round(params.holeDiaMm / 2 / Math.min(pxPerMmX, pxPerMmY))) : 0;
    const holeBottom = params.hollow && params.drainHoles ? Math.max(0, Math.floor(numLayers * 0.05)) : -1;
    const holeTop = params.hollow && params.drainHoles ? Math.max(0, Math.floor(numLayers * 0.85)) : -1;
    for (let i = 0; i < numLayers; i++) {
      const z = zMin + (i + 0.5) * layerHeight;
      const wall = i < solidBase ? 0 : wallMm;
      const data = fillBetweenZ(z, wall, W, H);
      if (i === holeBottom || i === holeTop) carveEdgeHole(data, holeR, W, H);
      layers.push({ index: i, z, data });
    }
  } else {
    // WASM není — JS fill (fallback)
    const wallMm = params.hollow ? Math.max(params.wallMm, 0) : 0;
    const solidBase = params.hollow ? Math.max(1, Math.floor(numLayers * 0.02)) : 0;
    const holeR = params.drainHoles ? Math.max(1, Math.round(params.holeDiaMm / 2 / Math.min(pxPerMmX, pxPerMmY))) : 0;
    const holeBottom = params.hollow && params.drainHoles ? Math.max(0, Math.floor(numLayers * 0.05)) : -1;
    const holeTop = params.hollow && params.drainHoles ? Math.max(0, Math.floor(numLayers * 0.85)) : -1;
    for (let i = 0; i < numLayers; i++) {
      const z = zMin + (i + 0.5) * layerHeight;
      const wall = i < solidBase ? 0 : wallMm;
      const data = new Uint8Array(n);
      for (let p = 0; p < n; p++) {
        if (front[p] + wall < z && z < back[p] - wall) data[p] = 1;
      }
      if (i === holeBottom || i === holeTop) carveEdgeHole(data, holeR, W, H);
      layers.push({ index: i, z, data });
    }
  }

  return {
    layers,
    layerHeight,
    resolutionX: W,
    resolutionY: H,
    minX: models[0].bounds.min[0],
    minY: models[0].bounds.min[1],
  };
}
