import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { unzipSync } from "fflate";
import { decodePw0Layer } from "../lib/anycubicLayer";

type Json = Record<string, any>;

function json(files: Record<string, Uint8Array>, name: string): Json | null {
  const bytes = files[name];
  return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
}

function bounds(data: Uint8Array, width: number, height: number) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  let lit = 0, gray = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const value = data[row + x];
      if (!value) continue;
      lit++;
      if (value !== 255) gray++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { lit, gray, minX, minY, maxX, maxY };
}

function writeCroppedPgm(
  path: string,
  data: Uint8Array,
  width: number,
  box: ReturnType<typeof bounds>,
  padding = 4
) {
  if (box.maxX < box.minX || box.maxY < box.minY) throw new Error("Selected layer is empty");
  const x0 = Math.max(0, box.minX - padding);
  const y0 = Math.max(0, box.minY - padding);
  const x1 = Math.min(width - 1, box.maxX + padding);
  const height = data.length / width;
  const y1 = Math.min(height - 1, box.maxY + padding);
  const cropW = x1 - x0 + 1;
  const cropH = y1 - y0 + 1;
  const header = Buffer.from(`P5\n${cropW} ${cropH}\n255\n`, "ascii");
  const crop = Buffer.allocUnsafe(cropW * cropH);
  for (let y = 0; y < cropH; y++) {
    crop.set(data.subarray((y + y0) * width + x0, (y + y0) * width + x1 + 1), y * cropW);
  }
  writeFileSync(path, Buffer.concat([header, crop]));
}

const input = process.argv[2];
if (!input) throw new Error("Usage: tsx scripts/analyze-anycubic-zip.ts <file.pm7|pwsz> [layer] [crop.pgm]");
const file = resolve(input);
const files = unzipSync(new Uint8Array(readFileSync(file)));
const settings = json(files, "anycubic_photon_resins.pwsp");
const controller = json(files, "layers_controller.conf");
const software = json(files, "software_info.conf");
if (!settings || !controller) throw new Error("Not an Anycubic ZIP slice: required manifests are missing");

const machine = settings.machine_type ?? {};
const width = Number(machine.res_x);
const height = Number(machine.res_y);
const layerNames = Object.keys(files)
  .filter((name) => /^layer_images\/layer_\d+\.(pw0Img|pwszImg)$/i.test(name))
  .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
const requestedLayer = process.argv[3] === undefined
  ? Math.floor(layerNames.length / 2)
  : Number(process.argv[3]);
const layerName = layerNames.find((name) => Number(name.match(/\d+/)![0]) === requestedLayer);
if (!layerName) throw new Error(`Layer ${requestedLayer} does not exist`);
if (!/\.pw0Img$/i.test(layerName)) throw new Error("PWSZ vector layers are detected but not decoded by this command yet");

const decoded = decodePw0Layer(files[layerName], width * height);
const box = bounds(decoded, width, height);
const layerParams = controller.paras ?? controller.layers ?? [];
console.log(JSON.stringify({
  file: basename(file),
  slicer: software,
  machine: {
    name: machine.name,
    suffix: machine.key_suffix,
    declaredImageFormat: machine.key_image_format,
    width,
    height,
    pixelMicronsX: machine.xy_pixel,
    pixelMicronsY: machine.xy_pixel_y,
  },
  layerCount: layerNames.length,
  declaredLayerCount: controller.count ?? layerParams.length,
  inspectedLayer: requestedLayer,
  layerFormat: layerName.slice(layerName.lastIndexOf(".") + 1),
  encodedBytes: files[layerName].length,
  decodedBytes: decoded.length,
  compressionRatio: Number((decoded.length / files[layerName].length).toFixed(2)),
  pixels: box,
  params: layerParams[requestedLayer] ?? null,
}, null, 2));

if (process.argv[4]) {
  const output = resolve(process.argv[4]);
  writeCroppedPgm(output, decoded, width, box);
  console.log(`Cropped layer written to ${output}`);
}
