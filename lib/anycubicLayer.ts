/** Decode Anycubic PW0/pw0Img RLE4 data into one 8-bit grayscale layer. */
export function decodePw0Layer(encoded: Uint8Array, pixelCount: number): Uint8Array {
  if (!Number.isSafeInteger(pixelCount) || pixelCount < 0) {
    throw new Error(`Invalid expected PW0 pixel count: ${pixelCount}`);
  }

  const out = new Uint8Array(pixelCount);
  let pixel = 0;

  for (let i = 0; i < encoded.length && pixel < pixelCount; i++) {
    const byte = encoded[i];
    const nibble = byte >>> 4;
    let repeat = byte & 0x0f;
    let color = (nibble << 4) | nibble;

    if (nibble === 0 || nibble === 0x0f) {
      if (++i >= encoded.length) {
        throw new Error(`PW0 ended inside a two-byte run after ${pixel} pixels`);
      }
      repeat = (repeat << 8) | encoded[i];
      color = nibble === 0 ? 0 : 255;
    }

    if (pixel + repeat > pixelCount) {
      throw new Error(
        `PW0 run at byte ${i} runs past the expected image size: ${pixel} + ${repeat} > ${pixelCount}`
      );
    }
    out.fill(color, pixel, pixel + repeat);
    pixel += repeat;
  }

  if (pixel !== pixelCount) {
    throw new Error(`PW0 ended after ${pixel} of ${pixelCount} pixels`);
  }
  return out;
}
