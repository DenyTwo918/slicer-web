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

/** Offset raw STL coordinates so its XY bounds center sits at the scene origin. */
export function meshCenterOffset(bounds: {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}): { x: number; y: number } {
  return {
    x: -(bounds.min[0] + bounds.max[0]) / 2,
    y: -(bounds.min[1] + bounds.max[1]) / 2,
  };
}

/** One canonical placement: center raw STL inside geometry, then apply only user translation to group. */
export function viewportMeshPlacement(
  bounds: { min: readonly [number, number, number]; max: readonly [number, number, number] },
  transform: { x: number; y: number }
): { geometryX: number; geometryY: number; groupX: number; groupY: number } {
  const geometry = meshCenterOffset(bounds);
  return {
    geometryX: geometry.x,
    geometryY: geometry.y,
    groupX: transform.x,
    groupY: transform.y,
  };
}
