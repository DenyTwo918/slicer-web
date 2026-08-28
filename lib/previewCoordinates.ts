export interface PreviewBitmapMapping {
  offsetX: number;
  offsetY: number;
  fullWidth: number;
  fullHeight: number;
}

/** Map raster coordinates back to the same XY axes used by the STL scene. */
export function bitmapPointToPlate(
  point: { x: number; y: number },
  mapping: PreviewBitmapMapping,
  printer: { printX: number; printY: number }
): { x: number; y: number } {
  return {
    x: (point.x + mapping.offsetX) * (printer.printX / mapping.fullWidth) - printer.printX / 2,
    y: (point.y + mapping.offsetY) * (printer.printY / mapping.fullHeight) - printer.printY / 2,
  };
}
