import { zipSync, strToU8 } from "fflate";
import type { SliceResult } from "./slice";
import type { StlMesh } from "./stl";

/**
 * Export .pm7 pro Anycubic Photon Mono M7.
 * Formát rozluštěn z UVtools zdrojáku (AnycubicZipFile.cs, AnycubicFile.cs)
 * a reálného vzorku Chituboxu (2026-08-25).
 *
 * Struktura ZIP:
 *  - anycubic_photon_resins.pwsp   (JSON — machine_type + machine_extern)
 *  - layers_controller.conf        (JSON — per-vrstva expozice)
 *  - print_info.json               (JSON)
 *  - software_info.conf            (JSON)
 *  - scene.slice                   (binární — hlavička + per-vrstva 60 B)
 *  - layer_images/layer_N.pw0Img   (RLE4 obraz v plném rozlišení 13312×5120)
 *  - preview_images/preview_0.png, preview_1.png
 */

export const M7_MACHINE = {
  name: "Anycubic Photon Mono M7",
  keySuffix: "pm7",
  keyImageFormat: "pwszImg",
  resX: 13312,
  resY: 5120,
  printX: 223.64, // mm
  printY: 126.48, // mm
  printZ: 230, // mm
  pixelXUm: 16.8,
  pixelYUm: 24.8,
};

// ------------------------------------------------------------- RLE4 (PW0)

/**
 * Kóduje 8bitový obraz (0..255) do RLE4 (pw0Img):
 * barva = pixel >> 4; runy barvy 0/0xf se píší jako 2 B big-endian
 * [color<<12 | done], limit 4095; ostatní barvy 1 B [color<<4 | done], limit 15.
 */
export function encodeRlePw0(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let lastColor = -1;
  let reps = 0;

  const put = (color: number, count: number) => {
    while (count > 0) {
      if (color === 0 || color === 0xf) {
        const done = Math.min(count, 4095);
        const more = done | (color << 12);
        out.push((more >> 8) & 0xff);
        out.push(more & 0xff);
        count -= done;
      } else {
        const done = Math.min(count, 15);
        out.push((done | (color << 4)) & 0xff);
        count -= done;
      }
    }
  };

  for (let i = 0; i < data.length; i++) {
    const color = data[i] >> 4;
    if (color === lastColor) {
      reps++;
    } else {
      put(lastColor, reps);
      lastColor = color;
      reps = 1;
    }
  }
  put(lastColor, reps);
  return new Uint8Array(out);
}

/** Up-scale vrstvy (slice rastr) na plné rozlišení tiskárny a zakóduje RLE. */
function encodeLayerToMachine(
  layer: { data: Uint8Array },
  slice: SliceResult
): Uint8Array {
  const mx = M7_MACHINE.resX;
  const my = M7_MACHINE.resY;
  const sx = mx / slice.resolutionX;
  const sy = my / slice.resolutionY;
  const full = new Uint8Array(mx * my);
  const src = layer.data;
  for (let y = 0; y < slice.resolutionY; y++) {
    const y0 = Math.floor(y * sy);
    for (let x = 0; x < slice.resolutionX; x++) {
      if (src[y * slice.resolutionX + x]) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.min(mx, x0 + sx);
        for (let yy = y0; yy < Math.min(my, y0 + sy); yy++) {
          full.fill(255, yy * mx + x0, yy * mx + x1);
        }
      }
    }
  }
  return encodeRlePw0(full);
}

// ------------------------------------------------------------- scene.slice

class BinWriter {
  buf: number[] = [];
  u8(...v: number[]) {
    for (const x of v) this.buf.push(x & 0xff);
  }
  u32(v: number) {
    this.buf.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  }
  f32(v: number) {
    const b = new ArrayBuffer(4);
    new DataView(b).setFloat32(0, v, true);
    this.buf.push(...new Uint8Array(b));
  }
  str(len: number, s: string) {
    const b = new Uint8Array(len);
    for (let i = 0; i < s.length && i < len; i++) b[i] = s.charCodeAt(i);
    this.buf.push(...b);
  }
  toU8() {
    return new Uint8Array(this.buf);
  }
}

interface SceneLayerInfo {
  z: number;
  areaMm2: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Serializace scene.slice (SceneManifest):
 * magic 16 B, software 64 B, hlavička (uinty/floaty), padding 64×uint,
 * "<---", LayerDefCount, per-vrstva 60 B, "--->".
 */
export function encodeSceneSlice(
  opts: {
    layerCount: number;
    bounds: StlMesh["bounds"];
    layers: SceneLayerInfo[];
  }
): Uint8Array {
  const w = new BinWriter();
  const cx = M7_MACHINE.printX / 2;
  const cy = M7_MACHINE.printY / 2;
  const { min, max } = opts.bounds;

  w.str(16, "ANYCUBIC-PWSZ");
  w.str(64, "slicer-web 0.1 (web slicer)");
  w.u32(3); // BinaryType (FPGA Release)
  w.u32(1); // Version
  w.u32(0); // SliceType
  w.u32(0); // ModelUnit (mm)
  w.f32(1); // PointRatio
  w.u32(opts.layerCount);
  w.f32(min[0] - cx);
  w.f32(min[1] - cy);
  w.f32(min[2]);
  w.f32(max[0] - cx);
  w.f32(max[1] - cy);
  w.f32(max[2]);
  w.u32(0); // ModelStats
  for (let i = 0; i < 64; i++) w.u32(0);
  w.str(4, "<---");
  w.u32(opts.layerCount);
  for (const L of opts.layers) {
    w.f32(L.z);
    w.f32(L.areaMm2);
    w.f32(L.x0 - cx);
    w.f32(L.y0 - cy);
    w.f32(L.x1 - cx);
    w.f32(L.y1 - cy);
    w.u32(1); // ObjectCount (metadata)
    w.f32(L.areaMm2); // MaxContourArea (metadata)
    for (let i = 0; i < 8; i++) w.u32(0); // Padding 8×uint
  }
  w.str(4, "--->");
  return w.toU8();
}

// ------------------------------------------------------------- JSON soubory

function buildPwsp() {
  const m = M7_MACHINE;
  return {
    machine_extern: {
      active_resins: ["user_resin"],
      alias: m.name,
      cloud_property: 0,
      device_cn_code: "",
      user_resins: [
        {
          property: {
            code: "10",
            currency: "$",
            density: 1.2,
            name: "user_resin",
            price: 220,
            subfunc_code: 0,
            target_temperature: 25,
            type: "nor_resin_type",
            version: "3",
            volume: 1000,
          },
          slicepara: {
            anti_count: 1,
            blur_level: 0,
            bott_layers: 5,
            bott_time: 25,
            exposure_time: 2.5,
            gray_level: 0,
            off_time: 0.5,
            use_indivi_layerpara: 0,
            use_random_erode: 0,
            zdown_speed: 6,
            zthick: 0.05,
            zup_height: 1.0,
            zup_speed: 1.0,
          },
          slice_extpara: {
            exposure_compensate: 0,
            intelli_mode: 1,
            max_acceleration: 2,
            multi_state_paras: {
              bott_0: { down_speed: 1.0, height: 1.5, up_speed: 0.5 },
              bott_1: { down_speed: 5.0, height: 1.5, up_speed: 4.0 },
              normal_0: { down_speed: 1.0, height: 1.0, up_speed: 1.0 },
              normal_1: { down_speed: 5.0, height: 2.0, up_speed: 6.0 },
            },
            multi_state_used: 1,
            separate_support_exposure_delayed: 0,
            transition_layercount: 15,
            transition_type: 0,
            version: "3",
          },
          version: "2",
        },
      ],
      version: "2",
    },
    machine_type: {
      name: m.name,
      key_image_format: m.keyImageFormat,
      key_suffix: m.keySuffix,
      res_x: m.resX,
      res_y: m.resY,
      print_xsize: m.printX,
      print_ysize: m.printY,
      print_zsize: m.printZ,
      xy_pixel: 16.8,
      xy_pixel_y: 24.7,
      raster_antialiasing: 4,
      raster_segments_capacity: 100000,
      prev_image_size: [224, 168],
      prev_back_color: [0.0078125, 0.28125, 0.390625],
      prev_model_color: [0.8046875, 0.8046875, 0.8046875],
      prev_supports_color: [0.07421875, 0.92578125, 0.9296875],
      prev2_image_size: [336, 252],
      prev2_back_color: [0.07843, 0.10588, 0.16078],
      child_screen: [{ height: m.resY, width: m.resX, x: 0, y: 0 }],
      property: 119,
      max_file_version: 518,
      max_samples: 16,
      version: "3",
    },
    version: "3",
  };
}

function buildLayersController(
  slice: SliceResult,
  layerTimes: number[]
) {
  return {
    count: slice.layers.length,
    paras: slice.layers.map((l, i) => ({
      layer_index: i,
      exposure_time: layerTimes[i],
      layer_minheight: Number((i * slice.layerHeight).toFixed(4)),
      layer_thickness: Number(slice.layerHeight.toFixed(4)),
      zup_height: i < 5 ? 1.5 : 1.0,
      zup_speed: i < 5 ? 0.5 : 1.0,
    })),
  };
}

function buildPrintInfo(volumeMl: number, printTimeS: number) {
  return {
    cost: 0,
    currency: "$",
    print_time: printTimeS,
    volume: Number(volumeMl.toFixed(4)),
  };
}

// ------------------------------------------------------------- preview PNG

async function makePreviewPng(
  slice: SliceResult,
  layerIdx: number,
  w: number,
  h: number
): Promise<Uint8Array> {
  const layer = slice.layers[layerIdx];
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D není dostupné.");
  ctx.fillStyle = "#052636";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#ffffff";
  const sx = w / slice.resolutionX;
  const sy = h / slice.resolutionY;
  const src = layer.data;
  for (let y = 0; y < slice.resolutionY; y++) {
    for (let x = 0; x < slice.resolutionX; x++) {
      if (src[y * slice.resolutionX + x]) {
        ctx.fillRect(x * sx, y * sy, sx + 1, sy + 1);
      }
    }
  }
  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob selhalo"))), "image/png")
  );
  return new Uint8Array(await blob.arrayBuffer());
}

// ------------------------------------------------------------- sestavení .pm7

export interface Pm7Options {
  /** jméno modelu (bez přípony) — určuje název souboru */
  modelName?: string;
  /** expozice prvních vrstev (s) */
  bottomExposure?: number;
  /** expozice běžných vrstev (s) */
  normalExposure?: number;
  /** počet prvních vrstev */
  bottomLayers?: number;
}

/**
 * Sestaví kompletní .pm7 soubor (Uint8Array) z mesh a slice výsledku.
 * Vrstvy se up-scalují do plného rozlišení M7 (13312×5120) a kódují RLE4.
 */
export async function buildPm7(
  mesh: StlMesh,
  slice: SliceResult,
  opts: Pm7Options = {}
): Promise<Uint8Array> {
  const bottomExposure = opts.bottomExposure ?? 25;
  const normalExposure = opts.normalExposure ?? 2.5;
  const bottomLayers = opts.bottomLayers ?? 5;

  // per-vrstva info pro scene.slice
  const pxMm = M7_MACHINE.printX / M7_MACHINE.resX;
  const pyMm = M7_MACHINE.printY / M7_MACHINE.resY;
  const layerInfo: SceneLayerInfo[] = slice.layers.map((l) => {
    const src = l.data;
    let count = 0;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let y = 0; y < slice.resolutionY; y++) {
      const row = y * slice.resolutionX;
      for (let x = 0; x < slice.resolutionX; x++) {
        if (src[row + x]) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const areaMm2 = count * pxMm * pyMm;
    const x0 = minX === Infinity ? 0 : minX * pxMm;
    const y0 = minY === Infinity ? 0 : minY * pyMm;
    const x1 = maxX === -1 ? 0 : (maxX + 1) * pxMm;
    const y1 = maxY === -1 ? 0 : (maxY + 1) * pyMm;
    return { z: l.z, areaMm2, x0, y0, x1, y1 };
  });

  // expozice per vrstva
  const layerTimes = slice.layers.map((_, i) =>
    i < bottomLayers ? bottomExposure : normalExposure
  );

  // RLE vrstvy (plné rozlišení)
  const rleLayers: Uint8Array[] = [];
  for (const l of slice.layers) {
    rleLayers.push(encodeLayerToMachine(l, slice));
  }

  // preview PNG
  const mid = Math.floor(slice.layers.length / 2);
  const [preview0, preview1] = await Promise.all([
    makePreviewPng(slice, 0, 224, 168),
    makePreviewPng(slice, Math.max(1, mid), 224, 168),
  ]);

  const volumeMl = (() => {
    // objem mesh (mm3) -> ml
    let vol = 0;
    const p = mesh.positions;
    for (let t = 0; t < mesh.triangleCount; t++) {
      const o = t * 9;
      const v0 = [p[o], p[o + 1], p[o + 2]];
      const v1 = [p[o + 3], p[o + 4], p[o + 5]];
      const v2 = [p[o + 6], p[o + 7], p[o + 8]];
      const cx = v0[1] * v1[2] - v0[2] * v1[1];
      const cy = v0[2] * v1[0] - v0[0] * v1[2];
      const cz = v0[0] * v1[1] - v0[1] * v1[0];
      vol += v0[0] * cx + v0[1] * cy + v0[2] * cz;
    }
    return Math.abs(vol) / 6 / 1000;
  })();

  const printTimeS = Math.round(
    slice.layers.length * 10 // hrubý odhad ~10 s na vrstvu
  );

  const files: Record<string, Uint8Array> = {
    "anycubic_photon_resins.pwsp": strToU8(
      JSON.stringify(buildPwsp(), null, 4)
    ),
    "layers_controller.conf": strToU8(
      JSON.stringify(buildLayersController(slice, layerTimes), null, 4)
    ),
    "print_info.json": strToU8(
      JSON.stringify(buildPrintInfo(volumeMl, printTimeS))
    ),
    "software_info.conf": strToU8(
      JSON.stringify(
        { mark: "CHITUBOX", opengl: "3.3-CoreProfile", os: "win-64", version: "1.2.3" },
        null,
        4
      )
    ),
    "scene.slice": encodeSceneSlice({
      layerCount: slice.layers.length,
      bounds: mesh.bounds,
      layers: layerInfo,
    }),
    "preview_images/preview_0.png": preview0,
    "preview_images/preview_1.png": preview1,
  };
  slice.layers.forEach((_, i) => {
    files[`layer_images/layer_${i}.pw0Img`] = rleLayers[i];
  });

  // hranice s fflate: TS 5.7 generické Uint8Array vs. typy knihovny
  return zipSync(
    files as unknown as Record<string, Uint8Array<ArrayBuffer>>
  );
}
