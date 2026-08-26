import { zipSync, strToU8 } from "fflate";
import type { SliceResult } from "./slice";
import type { StlMesh } from "./stl";
import { totalVolume, unionBounds } from "./transform";
import { getPrinter, type PrinterProfile } from "./profiles";

/**
 * Export souborů pro SLA tiskárny (Anycubic .pm7/.pwsz aj.).
 * Formát rozluštěn z UVtools zdrojáku (AnycubicZipFile.cs, AnycubicFile.cs)
 * a reálného vzorku Chituboxu (2026-08-25).
 *
 * Struktura ZIP:
 *  - anycubic_photon_resins.pwsp   (JSON — machine_type + machine_extern)
 *  - layers_controller.conf        (JSON — per-vrstva expozice)
 *  - print_info.json               (JSON)
 *  - software_info.conf            (JSON)
 *  - scene.slice                   (binární — hlavička + per-vrstva 64 B)
 *  - layer_images/layer_N.pw0Img   (RLE4 obraz v plném rozlišení)
 *  - preview_images/preview_0.png, preview_1.png
 */

/** Výchozí stroj (Anycubic Photon Mono M7) — použije se, když není zadán. */
export const M7_MACHINE: PrinterProfile = getPrinter("m7");

// ------------------------------------------------------------- RLE4 (PW0)

/**
 * Writer RLE4: barva = pixel >> 4; runy barvy 0/0xf se píší 2 B big-endian
 * [color<<12 | done] s limitem 4095; ostatní barvy 1 B [color<<4 | done], limit 15.
 */
function rleWriter() {
  const out: number[] = [];
  let lastColor = -1;
  let reps = 0;

  const put = (color: number, count: number) => {
    while (count > 0) {
      if (color === 0 || color === 0xf) {
        const done = Math.min(count, 4095);
        const more = done | (color << 12);
        out.push((more >> 8) & 0xff, more & 0xff);
        count -= done;
      } else {
        const done = Math.min(count, 15);
        out.push((done | (color << 4)) & 0xff);
        count -= done;
      }
    }
  };

  const push = (color: number, count: number) => {
    if (color === lastColor) {
      reps += count;
    } else {
      put(lastColor, reps);
      lastColor = color;
      reps = count;
    }
  };

  const finish = () => {
    put(lastColor, reps);
    return new Uint8Array(out);
  };

  return { push, finish };
}

/** Kóduje 8bitový obraz (0..255) do RLE4 (pw0Img). */
export function encodeRlePw0(data: Uint8Array): Uint8Array {
  const w = rleWriter();
  for (let i = 0; i < data.length; i++) {
    w.push(data[i] >> 4, 1);
  }
  return w.finish();
}

/**
 * Kóduje plnorozlišovací bitmapu (scale 1) do RLE4 — pro full-res streaming export.
 */
export function encodeLayerToMachineInternal(
  data: Uint8Array,
  resX: number,
  resY: number,
  _machine: PrinterProfile
): Uint8Array {
  const w = rleWriter();
  for (let y = 0; y < resY; y++) {
    let c = data[y * resX] ? 0xf : 0;
    let len = 1;
    for (let x = 1; x < resX; x++) {
      const nc = data[y * resX + x] ? 0xf : 0;
      if (nc === c) len++;
      else {
        w.push(c, len);
        c = nc;
        len = 1;
      }
    }
    w.push(c, len);
  }
  return w.finish();
}

/**
 * Up-scale vrstvy na plné rozlišení tiskárny a zakóduje RLE4 PŘÍMO (streaming).
 * Předpokládá, že rozlišení slice dělí rozlišení stroje beze zbytku (scale = 8/4/2/1).
 */
function encodeLayerToMachine(
  layer: { data: Uint8Array },
  slice: SliceResult,
  machine: PrinterProfile
): Uint8Array {
  const sx = machine.resX / slice.resolutionX;
  const sy = machine.resY / slice.resolutionY;
  const src = layer.data;
  const w = rleWriter();

  for (let y = 0; y < slice.resolutionY; y++) {
    const runs: { color: number; len: number }[] = [];
    let c = src[y * slice.resolutionX] ? 0xf : 0;
    let len = 1;
    for (let x = 1; x < slice.resolutionX; x++) {
      const nc = src[y * slice.resolutionX + x] ? 0xf : 0;
      if (nc === c) len++;
      else {
        runs.push({ color: c, len: len * sx });
        c = nc;
        len = 1;
      }
    }
    runs.push({ color: c, len: len * sx });

    for (let r = 0; r < sy; r++) {
      for (const run of runs) w.push(run.color, run.len);
    }
  }
  return w.finish();
}

// ------------------------------------------------------------- scene.slice

class BinWriter {
  buf: number[] = [];
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

export interface SceneLayerInfo {
  z: number;
  areaMm2: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export function encodeSceneSlice(
  opts: {
    layerCount: number;
    bounds: StlMesh["bounds"];
    layers: SceneLayerInfo[];
  },
  machine: PrinterProfile
): Uint8Array {
  const w = new BinWriter();
  const cx = machine.printX / 2;
  const cy = machine.printY / 2;
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

export function buildPwsp(machine: PrinterProfile) {
  return {
    machine_extern: {
      active_resins: ["user_resin"],
      alias: `${machine.brand} ${machine.name}`,
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
      name: `${machine.brand} ${machine.name}`,
      key_image_format: machine.keyImageFormat,
      key_suffix: machine.keySuffix,
      res_x: machine.resX,
      res_y: machine.resY,
      print_xsize: machine.printX,
      print_ysize: machine.printY,
      print_zsize: machine.printZ,
      xy_pixel: machine.pixelXUm,
      xy_pixel_y: machine.pixelYUm,
      raster_antialiasing: 4,
      raster_segments_capacity: 100000,
      prev_image_size: [224, 168],
      prev_back_color: [0.0078125, 0.28125, 0.390625],
      prev_model_color: [0.8046875, 0.8046875, 0.8046875],
      prev_supports_color: [0.07421875, 0.92578125, 0.9296875],
      prev2_image_size: [336, 252],
      prev2_back_color: [0.07843, 0.10588, 0.16078],
      child_screen: [{ height: machine.resY, width: machine.resX, x: 0, y: 0 }],
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
  layerTimes: number[],
  zup: { zupHeightBottom: number; zupSpeedBottom: number; zupHeight: number; zupSpeed: number }
) {
  return buildLayersControllerFrom(slice.layers.length, slice.layerHeight, layerTimes, zup);
}

export function buildLayersControllerFrom(
  count: number,
  layerHeight: number,
  layerTimes: number[],
  zup: { zupHeightBottom: number; zupSpeedBottom: number; zupHeight: number; zupSpeed: number }
) {
  return {
    count,
    paras: Array.from({ length: count }, (_, i) => ({
      layer_index: i,
      exposure_time: layerTimes[i],
      layer_minheight: Number((i * layerHeight).toFixed(4)),
      layer_thickness: Number(layerHeight.toFixed(4)),
      zup_height: i < 5 ? zup.zupHeightBottom : zup.zupHeight,
      zup_speed: i < 5 ? zup.zupSpeedBottom : zup.zupSpeed,
    })),
  };
}

export function buildPrintInfo(volumeMl: number, printTimeS: number) {
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
  if (typeof document === "undefined") {
    return new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64"
      )
    );
  }
  const layer = slice.layers[layerIdx];
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D není dostupné.");
  ctx.fillStyle = "#052636";
  ctx.fillRect(0, 0, w, h);
  const sx = w / slice.resolutionX;
  const sy = h / slice.resolutionY;
  const src = layer.data;
  for (let y = 0; y < slice.resolutionY; y++) {
    for (let x = 0; x < slice.resolutionX; x++) {
      const v = src[y * slice.resolutionX + x];
      if (v > 0) {
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(x * sx, y * sy, sx + 1, sy + 1);
      }
    }
  }
  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob selhalo"))), "image/png")
  );
  return new Uint8Array(await blob.arrayBuffer());
}

// ------------------------------------------------------------- sestavení souboru

export interface Pm7Options {
  modelName?: string;
  bottomExposure?: number;
  normalExposure?: number;
  bottomLayers?: number;
  /** tiskárna — default Anycubic M7 */
  printer?: PrinterProfile;
  /** zvedání (lift) — první vrstvy */
  zupHeightBottom?: number;
  zupSpeedBottom?: number;
  /** zvedání — běžné vrstvy */
  zupHeight?: number;
  zupSpeed?: number;
  zdownSpeed?: number;
  /** celkový odhad času tisku (s) — jde do print_info.json */
  printTimeS?: number;
}

/**
 * Sestaví kompletní tiskový soubor (Uint8Array) z meshes a slice výsledku.
 * Vrstvy se up-scalují do plného rozlišení tiskárny a kódují RLE4.
 */
export async function buildPm7(
  meshes: StlMesh[],
  slice: SliceResult,
  opts: Pm7Options = {}
): Promise<Uint8Array> {
  const machine = opts.printer ?? M7_MACHINE;
  const bottomExposure = opts.bottomExposure ?? 25;
  const normalExposure = opts.normalExposure ?? 2.5;
  const bottomLayers = opts.bottomLayers ?? 5;

  const pxMm = machine.printX / machine.resX;
  const pyMm = machine.printY / machine.resY;
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

  const layerTimes = slice.layers.map((_, i) =>
    i < bottomLayers ? bottomExposure : normalExposure
  );

  const zup = {
    zupHeightBottom: opts.zupHeightBottom ?? 1.5,
    zupSpeedBottom: opts.zupSpeedBottom ?? 0.5,
    zupHeight: opts.zupHeight ?? 1.0,
    zupSpeed: opts.zupSpeed ?? 1.0,
  };

  const rleLayers: Uint8Array[] = [];
  for (const l of slice.layers) {
    rleLayers.push(encodeLayerToMachine(l, slice, machine));
  }

  const mid = Math.floor(slice.layers.length / 2);
  const [preview0, preview1] = await Promise.all([
    makePreviewPng(slice, 0, 224, 168),
    makePreviewPng(slice, Math.max(1, mid), 224, 168),
  ]);

  const volumeMl = totalVolume(meshes) / 1000;
  const printTimeS =
    opts.printTimeS ?? Math.round(slice.layers.length * 10);

  const files: Record<string, Uint8Array> = {
    "anycubic_photon_resins.pwsp": strToU8(JSON.stringify(buildPwsp(machine), null, 4)),
    "layers_controller.conf": strToU8(
      JSON.stringify(buildLayersController(slice, layerTimes, zup), null, 4)
    ),
    "print_info.json": strToU8(JSON.stringify(buildPrintInfo(volumeMl, printTimeS))),
    "software_info.conf": strToU8(
      JSON.stringify(
        { mark: "CHITUBOX", opengl: "3.3-CoreProfile", os: "win-64", version: "1.2.3" },
        null,
        4
      )
    ),
    "scene.slice": encodeSceneSlice(
      {
        layerCount: slice.layers.length,
        bounds: unionBounds(meshes),
        layers: layerInfo,
      },
      machine
    ),
    "preview_images/preview_0.png": preview0,
    "preview_images/preview_1.png": preview1,
  };
  slice.layers.forEach((_, i) => {
    files[`layer_images/layer_${i}.pw0Img`] = rleLayers[i];
  });

  return zipSync(files as unknown as Record<string, Uint8Array<ArrayBuffer>>);
}
