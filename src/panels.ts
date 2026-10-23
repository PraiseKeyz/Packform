import type { PageInfo, Rect, Segment } from "./pdf";
import { segLength, styleKey, styleOf, type LineStyle } from "./styles";

export type Point = [number, number];

/** An area of the dieline enclosed by lines: a wall, flap, lid, label… In PDF points, top-left origin. */
export interface Panel {
  id: number;
  polygon: Point[];
  /** Area in square points. */
  area: number;
  bbox: Rect;
  centroid: Point;
}

/** A fold line joining two panels. */
export interface Hinge {
  a: number;
  b: number;
  p1: Point;
  p2: Point;
  length: number;
}

export interface PanelAnalysis {
  panels: Panel[];
  hinges: Hinge[];
  /** The line style that joins panels (the folds), if any. */
  foldStyle?: LineStyle;
}

const MAX_GRID = 1800; // pixels on the longest side
const LINE_R = 1; // lines are drawn 3 px thick
const GAP_CLOSE = 3.5; // points (~1.2 mm) added to each end of straight lines

interface Grid {
  w: number;
  h: number;
  s: number; // pixels per point
  x0: number;
  y0: number;
  pad: number;
}

interface Region {
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  border: boolean;
}

function makeGrid(segments: Segment[]): Grid {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of segments) {
    x0 = Math.min(x0, s.x1, s.x2);
    y0 = Math.min(y0, s.y1, s.y2);
    x1 = Math.max(x1, s.x1, s.x2);
    y1 = Math.max(y1, s.y1, s.y2);
  }
  const s = Math.min(3, MAX_GRID / Math.max(1, x1 - x0, y1 - y0));
  const pad = 6;
  return { w: Math.ceil((x1 - x0) * s) + pad * 2, h: Math.ceil((y1 - y0) * s) + pad * 2, s, x0, y0, pad };
}

const toPx = (g: Grid, x: number, y: number): Point => [(x - g.x0) * g.s + g.pad, (y - g.y0) * g.s + g.pad];
const toPt = (g: Grid, px: number, py: number): Point => [(px - g.pad) / g.s + g.x0, (py - g.pad) / g.s + g.y0];

function rasterize(g: Grid, segments: Segment[]): Uint8Array {
  const grid = new Uint8Array(g.w * g.h);
  for (const seg of segments) {
    // Fold lines often stop ~1 mm short of corners on purpose; stretch straight lines a little so panels still close
    const L = segLength(seg);
    const ext = seg.curved || L < 1 ? 0 : GAP_CLOSE / L;
    const [ax, ay] = toPx(g, seg.x1 - (seg.x2 - seg.x1) * ext, seg.y1 - (seg.y2 - seg.y1) * ext);
    const [bx, by] = toPx(g, seg.x2 + (seg.x2 - seg.x1) * ext, seg.y2 + (seg.y2 - seg.y1) * ext);
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2) + 1;
    for (let i = 0; i <= n; i++) {
      const cx = Math.round(ax + ((bx - ax) * i) / n), cy = Math.round(ay + ((by - ay) * i) / n);
      for (let dy = -LINE_R; dy <= LINE_R; dy++)
        for (let dx = -LINE_R; dx <= LINE_R; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && y >= 0 && x < g.w && y < g.h) grid[y * g.w + x] = 1;
        }
    }
  }
  return grid;
}

/** Flood-fill the empty space between lines into numbered regions (-1 = on a line). */
function label(g: Grid, grid: Uint8Array): { labels: Int32Array; regions: Region[] } {
  const labels = new Int32Array(g.w * g.h).fill(-1);
  const regions: Region[] = [];
  const queue = new Int32Array(g.w * g.h);
  for (let start = 0; start < grid.length; start++) {
    if (grid[start] || labels[start] >= 0) continue;
    const id = regions.length;
    const r: Region = { area: 0, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, border: false };
    let head = 0, tail = 0;
    queue[tail++] = start;
    labels[start] = id;
    while (head < tail) {
      const i = queue[head++];
      const x = i % g.w, y = (i / g.w) | 0;
      r.area++;
      if (x < r.minX) r.minX = x;
      if (x > r.maxX) r.maxX = x;
      if (y < r.minY) r.minY = y;
      if (y > r.maxY) r.maxY = y;
      if (x === 0 || y === 0 || x === g.w - 1 || y === g.h - 1) r.border = true;
      for (const j of [x > 0 ? i - 1 : -1, x < g.w - 1 ? i + 1 : -1, y > 0 ? i - g.w : -1, y < g.h - 1 ? i + g.w : -1]) {
        if (j >= 0 && !grid[j] && labels[j] < 0) {
          labels[j] = id;
          queue[tail++] = j;
        }
      }
    }
    regions.push(r);
  }
  return { labels, regions };
}

/** A real panel: enclosed (not the outside), not tiny, and not a thin ring such as the strip between bleed and cut lines. */
function isPanel(g: Grid, r: Region) {
  if (r.border) return false;
  const boxArea = (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
  return r.area / (g.s * g.s) >= 40 && r.area / boxArea >= 0.25;
}

interface Separation {
  a: number;
  b: number;
  byStyle: Map<string, { style: LineStyle; length: number; pts: Point[] }>;
}

/** For every line, which two panels lie on either side of it (sampled along its length). */
function separations(g: Grid, segments: Segment[], labels: Int32Array, panel: (id: number) => boolean) {
  const out = new Map<string, Separation>();
  const probe = (px: number, py: number, nx: number, ny: number) => {
    for (let k = LINE_R + 1; k <= LINE_R + 5; k++) {
      const x = Math.round(px + nx * k), y = Math.round(py + ny * k);
      if (x < 0 || y < 0 || x >= g.w || y >= g.h) return -1;
      const l = labels[y * g.w + x];
      if (l >= 0) return l;
    }
    return -1;
  };
  for (const seg of segments) {
    const L = segLength(seg);
    if (L < 2) continue;
    const dx = (seg.x2 - seg.x1) / L, dy = (seg.y2 - seg.y1) / L;
    const step = 1.5;
    for (let t = Math.min(step, L / 2); t <= L - Math.min(step, L / 2) + 1e-6; t += step) {
      const x = seg.x1 + dx * t, y = seg.y1 + dy * t;
      const [px, py] = toPx(g, x, y);
      const la = probe(px, py, -dy, dx), lb = probe(px, py, dy, -dx);
      if (la < 0 || lb < 0 || la === lb || !panel(la) || !panel(lb)) continue;
      const [a, b] = la < lb ? [la, lb] : [lb, la];
      const key = `${a}:${b}`;
      if (!out.has(key)) out.set(key, { a, b, byStyle: new Map() });
      const sk = styleKey(styleOf(seg));
      const bs = out.get(key)!.byStyle;
      if (!bs.has(sk)) bs.set(sk, { style: styleOf(seg), length: 0, pts: [] });
      const e = bs.get(sk)!;
      e.length += step;
      e.pts.push([x, y]);
    }
  }
  return out;
}

/** Fit a straight hinge through sample points; undefined if they don't lie on a line. */
function fitHinge(pts: Point[]): { p1: Point; p2: Point; length: number } | undefined {
  if (pts.length < 3) return undefined;
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length, my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const d: Point = [Math.cos(angle), Math.sin(angle)];
  let lo = Infinity, hi = -Infinity, off = 0;
  for (const [x, y] of pts) {
    const t = (x - mx) * d[0] + (y - my) * d[1];
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
    off = Math.max(off, Math.abs(-(x - mx) * d[1] + (y - my) * d[0]));
  }
  if (off > 1.5) return undefined; // curved or zig-zag: not a fold you can hinge on
  lo -= 0.75;
  hi += 0.75;
  if (hi - lo < 8) return undefined; // shorter than ~3 mm
  return { p1: [mx + d[0] * lo, my + d[1] * lo], p2: [mx + d[0] * hi, my + d[1] * hi], length: hi - lo };
}

/** Grow each region into the line pixels around it, so panels meet at the middle of the line. */
function dilate(g: Grid, labels: Int32Array, times: number) {
  for (let it = 0; it < times; it++) {
    const next = labels.slice();
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] >= 0) continue;
      const x = i % g.w;
      const n = [x > 0 ? labels[i - 1] : -1, x < g.w - 1 ? labels[i + 1] : -1, i >= g.w ? labels[i - g.w] : -1, i + g.w < labels.length ? labels[i + g.w] : -1];
      const found = n.find((v) => v >= 0);
      if (found !== undefined) next[i] = found;
    }
    labels.set(next);
  }
}

/** Outline of one region as a polygon (marching squares), simplified. */
function outline(g: Grid, labels: Int32Array, id: number, r: Region): Point[] {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < g.w && y < g.h && labels[y * g.w + x] === id;
  const segs: [Point, Point][] = [];
  const T = (x: number, y: number): Point => [x + 0.5, y], R = (x: number, y: number): Point => [x + 1, y + 0.5];
  const B = (x: number, y: number): Point => [x + 0.5, y + 1], L = (x: number, y: number): Point => [x, y + 0.5];
  // the region has grown into the surrounding line pixels, so scan a little wider than its original box
  const m = LINE_R + 4;
  for (let y = r.minY - m; y <= r.maxY + m; y++) {
    for (let x = r.minX - m; x <= r.maxX + m; x++) {
      const c = (inside(x, y) ? 8 : 0) | (inside(x + 1, y) ? 4 : 0) | (inside(x + 1, y + 1) ? 2 : 0) | (inside(x, y + 1) ? 1 : 0);
      switch (c) {
        case 1: case 14: segs.push([L(x, y), B(x, y)]); break;
        case 2: case 13: segs.push([B(x, y), R(x, y)]); break;
        case 3: case 12: segs.push([L(x, y), R(x, y)]); break;
        case 4: case 11: segs.push([T(x, y), R(x, y)]); break;
        case 6: case 9: segs.push([T(x, y), B(x, y)]); break;
        case 7: case 8: segs.push([T(x, y), L(x, y)]); break;
        case 5: segs.push([T(x, y), R(x, y)], [L(x, y), B(x, y)]); break;
        case 10: segs.push([T(x, y), L(x, y)], [B(x, y), R(x, y)]); break;
      }
    }
  }
  // Chain the little segments into closed loops; keep the biggest (the outer edge)
  const key = (p: Point) => `${p[0]},${p[1]}`;
  const adj = new Map<string, number[]>();
  segs.forEach(([a, b], i) => {
    for (const p of [a, b]) {
      const k = key(p);
      if (!adj.has(k)) adj.set(k, []);
      adj.get(k)!.push(i);
    }
  });
  const used = new Uint8Array(segs.length);
  let best: Point[] = [];
  let bestArea = 0;
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const loop: Point[] = [segs[s0][0]];
    let cur = segs[s0][1];
    while (key(cur) !== key(loop[0])) {
      loop.push(cur);
      const next = (adj.get(key(cur)) ?? []).find((i) => !used[i]);
      if (next === undefined) break;
      used[next] = 1;
      cur = key(segs[next][0]) === key(cur) ? segs[next][1] : segs[next][0];
    }
    const a = Math.abs(polygonArea(loop));
    if (a > bestArea) {
      bestArea = a;
      best = loop;
    }
  }
  return simplify(best, 0.6).map(([x, y]) => toPt(g, x, y));
}

export function polygonArea(p: Point[]) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function centroidOf(p: Point[]): Point {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  return a ? [cx / (3 * a), cy / (3 * a)] : p[0];
}

/** Douglas-Peucker for a closed loop. */
function simplify(loop: Point[], eps: number): Point[] {
  if (loop.length < 4) return loop;
  const dp = (pts: Point[]): Point[] => {
    if (pts.length < 3) return pts;
    const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
    const L = Math.hypot(bx - ax, by - ay) || 1;
    let far = 0, idx = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L;
      if (d > far) {
        far = d;
        idx = i;
      }
    }
    if (far <= eps) return [pts[0], pts[pts.length - 1]];
    return [...dp(pts.slice(0, idx + 1)).slice(0, -1), ...dp(pts.slice(idx))];
  };
  // split the loop at its two most distant points
  let i0 = 0, i1 = 0, far = 0;
  for (let i = 0; i < loop.length; i += Math.max(1, Math.floor(loop.length / 64)))
    for (let j = 0; j < loop.length; j++) {
      const d = Math.hypot(loop[i][0] - loop[j][0], loop[i][1] - loop[j][1]);
      if (d > far) [far, i0, i1] = [d, i, j];
    }
  const [s, e] = i0 < i1 ? [i0, i1] : [i1, i0];
  const a = dp(loop.slice(s, e + 1));
  const b = dp([...loop.slice(e), ...loop.slice(0, s + 1)]);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/**
 * Find the panels of a dieline and the fold lines joining them, without trusting any colour convention:
 * every line is drawn as a wall, the enclosed areas become panels, and the line style that separates
 * the most panel-to-panel edges along straight lines is taken to be the folds.
 */
export function analyzePanels(page: PageInfo): PanelAnalysis {
  const segments = page.segments.filter((s) => segLength(s) > 0.2);
  if (!segments.length) return { panels: [], hinges: [] };
  const g = makeGrid(segments);

  // Pass 1: which style separates panels?
  let { labels, regions } = label(g, rasterize(g, segments));
  let panelIds = (id: number) => isPanel(g, regions[id]);
  const totals = new Map<string, { style: LineStyle; length: number }>();
  for (const sep of separations(g, segments, labels, panelIds).values()) {
    for (const [k, v] of sep.byStyle) {
      if (!fitHinge(v.pts)) continue;
      const t = totals.get(k) ?? { style: v.style, length: 0 };
      t.length += v.length;
      totals.set(k, t);
    }
  }
  const fold = [...totals.entries()].sort((a, b) => b[1].length - a[1].length)[0];

  let hinges: Hinge[] = [];
  if (fold) {
    // Pass 2: diagonal folds (e.g. the glued corners of crash-lock bottoms) don't hinge whole panels, so ignore them
    const [foldKey] = fold;
    const isFold = (s: Segment) => styleKey(styleOf(s)) === foldKey;
    const diagonal = (s: Segment) => {
      const a = (Math.atan2(Math.abs(s.y2 - s.y1), Math.abs(s.x2 - s.x1)) * 180) / Math.PI;
      return a > 3 && a < 87;
    };
    const walls = segments.filter((s) => !(isFold(s) && diagonal(s) && !s.curved));
    ({ labels, regions } = label(g, rasterize(g, walls)));
    panelIds = (id: number) => isPanel(g, regions[id]);
    for (const sep of separations(g, walls.filter(isFold), labels, panelIds).values()) {
      const v = sep.byStyle.get(foldKey);
      const h = v && fitHinge(v.pts);
      if (h) hinges.push({ a: sep.a, b: sep.b, ...h });
    }
  }

  dilate(g, labels, LINE_R + 2);
  const panels: Panel[] = [];
  const index = new Map<number, number>();
  regions.forEach((r, id) => {
    if (!panelIds(id)) return;
    const polygon = outline(g, labels, id, r);
    if (polygon.length < 3) return;
    const xs = polygon.map((p) => p[0]), ys = polygon.map((p) => p[1]);
    index.set(id, panels.length);
    panels.push({
      id: panels.length,
      polygon,
      area: Math.abs(polygonArea(polygon)),
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      centroid: centroidOf(polygon),
    });
  });
  hinges = hinges
    .filter((h) => index.has(h.a) && index.has(h.b))
    .map((h) => ({ ...h, a: index.get(h.a)!, b: index.get(h.b)! }));
  return { panels, hinges, foldStyle: fold?.[1].style };
}
