import { unzipSync } from "fflate";
import type { SliceResult } from "./slice";

export interface ExactLayerCrop {
  data: Uint8Array;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  fullWidth: number;
  fullHeight: number;
}

export interface Pm7PreviewArchive {
  layers: Uint8Array[];
  layerCount: number;
  resX: number;
  resY: number;
}

export interface NativeLayerPreview {
  z: number;
  data: Uint8Array;
  resX: number;
  resY: number;
  offsetX: number;
  offsetY: number;
  fullResX: number;
  fullResY: number;
  layerHeight: number;
}

type Run = { start: number; end: number; color: number };

function forEachPw0Run(
  encoded: Uint8Array,
  pixelCount: number,
  visit: (run: Run) => void
): void {
  let pixel = 0;
  for (let i = 0; i < encoded.length && pixel < pixelCount; i++) {
    const byte = encoded[i];
    const nibble = byte >>> 4;
    let repeat = byte & 0x0f;
    let color = (nibble << 4) | nibble;
    if (nibble === 0 || nibble === 0x0f) {
      if (++i >= encoded.length) throw new Error("PW0 ended inside a two-byte run");
      repeat = (repeat << 8) | encoded[i];
      color = nibble === 0 ? 0 : 255;
    }
    if (repeat <= 0 || pixel + repeat > pixelCount) {
      throw new Error(`Invalid PW0 run at pixel ${pixel}: ${repeat}`);
    }
    visit({ start: pixel, end: pixel + repeat, color });
    pixel += repeat;
  }
  if (pixel !== pixelCount) throw new Error(`PW0 ended after ${pixel} of ${pixelCount} pixels`);
}

/**
 * Decode only the non-empty bounding rectangle of one native PW0 layer.
 * This keeps a 12K/14K preview exact without allocating the full 60–70 MB screen.
 */
export function decodePw0Crop(
  encoded: Uint8Array,
  fullWidth: number,
  fullHeight: number
): ExactLayerCrop {
  if (!Number.isSafeInteger(fullWidth) || fullWidth <= 0 ||
      !Number.isSafeInteger(fullHeight) || fullHeight <= 0) {
    throw new Error(`Invalid PW0 dimensions: ${fullWidth}×${fullHeight}`);
  }
  const pixelCount = fullWidth * fullHeight;
  let minX = fullWidth;
  let minY = fullHeight;
  let maxX = -1;
  let maxY = -1;

  const visitRows = (run: Run, fn: (y: number, x0: number, x1: number, color: number) => void) => {
    if (run.color === 0) return;
    let pos = run.start;
    while (pos < run.end) {
      const y = Math.floor(pos / fullWidth);
      const x0 = pos - y * fullWidth;
      const count = Math.min(run.end - pos, fullWidth - x0);
      fn(y, x0, x0 + count, run.color);
      pos += count;
    }
  };

  forEachPw0Run(encoded, pixelCount, (run) => visitRows(run, (y, x0, x1) => {
    minX = Math.min(minX, x0);
    maxX = Math.max(maxX, x1 - 1);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }));

  if (maxX < minX || maxY < minY) {
    return {
      data: new Uint8Array(0), width: 0, height: 0,
      offsetX: 0, offsetY: 0, fullWidth, fullHeight,
    };
  }

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const data = new Uint8Array(width * height);
  forEachPw0Run(encoded, pixelCount, (run) => visitRows(run, (y, x0, x1, color) => {
    data.fill(color, (y - minY) * width + x0 - minX, (y - minY) * width + x1 - minX);
  }));

  return { data, width, height, offsetX: minX, offsetY: minY, fullWidth, fullHeight };
}

/** Open only compressed layer payloads from a PM7 ZIP, in numerical order. */
export function openPm7PreviewArchive(
  bytes: Uint8Array,
  resX: number,
  resY: number
): Pm7PreviewArchive {
  const files = unzipSync(bytes);
  const indexed: { index: number; data: Uint8Array }[] = [];
  for (const [name, data] of Object.entries(files)) {
    const match = /^layer_images\/layer_(\d+)\.pw0Img$/i.exec(name);
    if (match) indexed.push({ index: Number(match[1]), data });
  }
  indexed.sort((a, b) => a.index - b.index);
  if (indexed.length === 0) throw new Error("PM7 archive contains no PW0 layers");
  indexed.forEach((entry, expected) => {
    if (entry.index !== expected) {
      throw new Error(`PM7 layer indices must be contiguous from 0 (expected ${expected}, got ${entry.index})`);
    }
  });
  const layers = indexed.map((entry) => entry.data);
  return { layers, layerCount: layers.length, resX, resY };
}

/**
 * While native PW0 generation is still running, return an empty surface with
 * the correct Z so the real STL clipping plane remains interactive. Once the
 * archive exists, replace it atomically with the exact exported layer crop.
 */
export function buildNativeLayerPreview(
  slice: SliceResult | null,
  archive: Pm7PreviewArchive | null,
  layerIndex: number
): NativeLayerPreview | null {
  if (!slice) return null;
  const layer = slice.layers[layerIndex];
  if (!layer) return null;
  if (!archive) {
    return {
      z: layer.z,
      data: new Uint8Array(0),
      resX: 0,
      resY: 0,
      offsetX: 0,
      offsetY: 0,
      fullResX: 0,
      fullResY: 0,
      layerHeight: slice.layerHeight,
    };
  }
  const encoded = archive.layers[layerIndex];
  if (!encoded) throw new Error(`Missing native preview layer ${layerIndex}`);
  const crop = decodePw0Crop(encoded, archive.resX, archive.resY);
  return {
    z: layer.z,
    data: crop.data,
    resX: crop.width,
    resY: crop.height,
    offsetX: crop.offsetX,
    offsetY: crop.offsetY,
    fullResX: crop.fullWidth,
    fullResY: crop.fullHeight,
    layerHeight: slice.layerHeight,
  };
}
