export interface PreviewPoint2 {
  x: number;
  y: number;
}

const pointKey = (point: PreviewPoint2) => `${point.x},${point.y}`;
const directedEdgeKey = (a: PreviewPoint2, b: PreviewPoint2) => `${pointKey(a)}>${pointKey(b)}`;

/**
 * Vytvoří přesné hranové smyčky binární masky. Při diagonálním dotyku má uzel
 * více pokračování; pravidlo „materiál vpravo“ udrží komponenty oddělené a
 * zabrání samoprotínajícím bow-tie polygonům, které Earcut vyplňoval obřími
 * trojúhelníky přes prázdný prostor.
 */
export function traceMaskContours(
  mask: Uint8Array,
  width: number,
  height: number,
  threshold = 0,
): PreviewPoint2[][] {
  const outgoing = new Map<string, PreviewPoint2[]>();
  const edges: { a: PreviewPoint2; b: PreviewPoint2 }[] = [];
  const on = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] > threshold;
  const add = (a: PreviewPoint2, b: PreviewPoint2) => {
    edges.push({ a, b });
    const list = outgoing.get(pointKey(a));
    if (list) list.push(b);
    else outgoing.set(pointKey(a), [b]);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!on(x, y)) continue;
      if (!on(x, y - 1)) add({ x, y }, { x: x + 1, y });
      if (!on(x + 1, y)) add({ x: x + 1, y }, { x: x + 1, y: y + 1 });
      if (!on(x, y + 1)) add({ x: x + 1, y: y + 1 }, { x, y: y + 1 });
      if (!on(x - 1, y)) add({ x, y: y + 1 }, { x, y });
    }
  }

  const used = new Set<string>();
  const loops: PreviewPoint2[][] = [];
  for (const edge of edges) {
    if (used.has(directedEdgeKey(edge.a, edge.b))) continue;
    const loop: PreviewPoint2[] = [edge.a];
    let previous = edge.a;
    let current = edge.b;
    for (let guard = 0; guard <= edges.length; guard++) {
      used.add(directedEdgeKey(previous, current));
      if (pointKey(current) === pointKey(loop[0])) break;
      loop.push(current);
      const candidates = (outgoing.get(pointKey(current)) ?? [])
        .filter((candidate) => !used.has(directedEdgeKey(current, candidate)));
      if (candidates.length === 0) break;
      const inX = current.x - previous.x;
      const inY = current.y - previous.y;
      const next = candidates.reduce((best, candidate) => {
        const score = (point: PreviewPoint2) => {
          const outX = point.x - current.x;
          const outY = point.y - current.y;
          const cross = inX * outY - inY * outX;
          const dot = inX * outX + inY * outY;
          if (dot < 0) return -100; // nikdy se nevracet po stejné hraně
          return cross * 10 + dot; // doprava, rovně, doleva
        };
        return score(candidate) > score(best) ? candidate : best;
      });
      previous = current;
      current = next;
    }
    if (loop.length >= 3 && pointKey(current) === pointKey(loop[0])) loops.push(loop);
  }
  return loops;
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
