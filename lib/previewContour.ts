export interface PreviewPoint2 {
  x: number;
  y: number;
}

function rdp(points: PreviewPoint2[], tolerance: number): PreviewPoint2[] {
  if (points.length <= 2) return points;
  const a = points[0];
  const b = points[points.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denom = dx * dx + dy * dy;
  let best = -1;
  let bestDist = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const t = denom > 0
      ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / denom))
      : 0;
    const ex = p.x - (a.x + t * dx);
    const ey = p.y - (a.y + t * dy);
    const distance = Math.hypot(ex, ey);
    if (distance > bestDist) {
      bestDist = distance;
      best = i;
    }
  }
  if (best < 0 || bestDist <= tolerance) return [a, b];
  const left = rdp(points.slice(0, best + 1), tolerance);
  const right = rdp(points.slice(best), tolerance);
  return [...left.slice(0, -1), ...right];
}

/**
 * Odstraní pixelové schody z uzavřeného zobrazovacího obrysu, ale neposouvá
 * jej o víc než zadanou toleranci. Raster tisku se tím nijak nemění.
 */
export function simplifyClosedPreviewContour(
  points: PreviewPoint2[],
  tolerancePx = 0.75,
): PreviewPoint2[] {
  if (points.length < 6 || tolerancePx <= 0) return points;
  let minI = 0;
  let maxI = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].x < points[minI].x) minI = i;
    if (points[i].x > points[maxI].x) maxI = i;
  }
  if (minI === maxI) return points;
  const path = (from: number, to: number) => {
    const out: PreviewPoint2[] = [];
    for (let i = from; ; i = (i + 1) % points.length) {
      out.push(points[i]);
      if (i === to) break;
    }
    return out;
  };
  const a = rdp(path(minI, maxI), tolerancePx);
  const b = rdp(path(maxI, minI), tolerancePx);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}
