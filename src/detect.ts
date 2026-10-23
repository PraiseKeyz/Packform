import type { PageInfo, Rect, Segment } from "./pdf";

export type FaceName = "front" | "right" | "back" | "left" | "top" | "bottom";

/** Clockwise rotation (degrees) that turns a cut-out panel the right way up for its face. */
export type Rotation = 0 | 90 | 180 | 270;

export interface FaceLayout {
  rect: Rect;
  rotate: Rotation;
}

/** How a group of lines is drawn. Dielines use one style per job (cut, fold, bleed, …), but colours vary by tool. */
export interface LineStyle {
  color: [number, number, number];
  width: number;
  dashed: boolean;
}

export interface BoxLayout {
  kind: "carton";
  /** Closed-box size in millimetres. */
  size: { width: number; height: number; depth: number };
  faces: Record<FaceName, FaceLayout>;
  /** The four wall panels in flat order (left to right), in PDF points. */
  walls: Rect[];
  /** The line style recognised as folds. */
  foldStyle: LineStyle;
  /** Page whose lines were used. */
  linesPage: number;
}

export interface LabelLayout {
  kind: "label";
  /** Finished (trimmed) label size in millimetres. */
  size: { width: number; height: number };
  /** The trim (cut) rectangle, in PDF points. */
  trim: Rect;
  /** The bleed rectangle, if the template has one. */
  bleed?: Rect;
  linesPage: number;
}

export type DielineLayout = BoxLayout | LabelLayout;

export interface DetectOptions {
  /** Which wall panel (1-4, left to right on the flat layout) is the front. Default: worked out from the top lid. */
  front?: number;
  /** Force the "which lines are folds?" test instead of trying every line style. */
  isCrease?: (segment: Segment) => boolean;
}

export const PT_TO_MM = 25.4 / 72;
const TOL = 3; // points (~1 mm)

const len = (s: Segment) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
const isVertical = (s: Segment) => Math.abs(s.x2 - s.x1) < 0.5 && Math.abs(s.y2 - s.y1) > 10;
const isHorizontal = (s: Segment) => Math.abs(s.y2 - s.y1) < 0.5 && Math.abs(s.x2 - s.x1) > 10;
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const mm = (pt: number) => Math.round(pt * PT_TO_MM * 2) / 2; // nearest 0.5 mm
const close = (a: number, b: number, rel = 0.04) => Math.abs(a - b) <= Math.max(TOL, rel * Math.max(a, b));

export const styleKey = (s: LineStyle) => `${s.color.join(",")}|${s.width.toFixed(2)}|${s.dashed ? "dashed" : "solid"}`;

/** Group segments by how they are drawn. */
export function lineStyles(segments: Segment[]): { style: LineStyle; segments: Segment[] }[] {
  const groups = new Map<string, { style: LineStyle; segments: Segment[] }>();
  for (const s of segments) {
    const style = { color: s.color, width: s.width, dashed: s.dashed };
    const key = styleKey(style);
    if (!groups.has(key)) groups.set(key, { style, segments: [] });
    groups.get(key)!.segments.push(s);
  }
  return [...groups.values()];
}

/** Group values that are within `tol` of each other; returns each group's mean and total weight. */
function cluster(items: { value: number; weight: number }[], tol = TOL) {
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const groups: { value: number; weight: number; n: number }[] = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && it.value - g.value / g.n <= tol) {
      g.value += it.value;
      g.weight += it.weight;
      g.n++;
    } else {
      groups.push({ value: it.value, weight: it.weight, n: 1 });
    }
  }
  return groups.map((g) => ({ value: g.value / g.n, weight: g.weight }));
}

/** Rotations that stand each lid upright, by the wall it hangs from. See the README for the derivation. */
const TOP_ROTATION: Record<"front" | "right" | "back" | "left", Rotation> = { front: 0, back: 180, left: 90, right: 270 };
const BOTTOM_ROTATION: Record<"front" | "right" | "back" | "left", Rotation> = { front: 0, back: 180, left: 270, right: 90 };
const WALL_ORDER = ["front", "right", "back", "left"] as const;

/**
 * Try to read a tuck-end carton (four walls in a row, a glue flap, a lid top and bottom),
 * treating the segments that pass `isFold` as fold lines. Throws if the shape doesn't fit.
 */
function cartonFrom(page: PageInfo, isFold: (s: Segment) => boolean, options: DetectOptions): BoxLayout {
  const folds = page.segments.filter(isFold);
  const verticals = folds.filter(isVertical);
  if (verticals.length < 3) throw new Error("fewer than 3 vertical fold lines");

  // 1. The long vertical folds between the walls: the longest lines in this style, all about the same length
  const vGroups = cluster(verticals.map((s) => ({ value: s.x1, weight: len(s) })));
  const longest = Math.max(...vGroups.map((g) => g.weight));
  const xs = vGroups.filter((g) => g.weight >= longest * 0.85).map((g) => g.value).slice(0, 5);
  if (xs.length < 3) throw new Error(`${xs.length} wall folds, need 3 or more`);

  const foldSegs = verticals.filter((s) => xs.some((x) => Math.abs(s.x1 - x) <= TOL));
  const top = median(foldSegs.map((s) => Math.min(s.y1, s.y2)));
  const bottom = median(foldSegs.map((s) => Math.max(s.y1, s.y2)));
  const height = bottom - top;
  // Every wall fold must run (almost) the full wall height
  for (const x of xs) {
    const run = foldSegs.filter((s) => Math.abs(s.x1 - x) <= TOL).reduce((a, s) => a + len(s), 0);
    if (run < height * 0.85) throw new Error("wall folds have different heights");
  }

  // 2. Walls: the gaps between folds, plus one more wall on whichever end has a long cut line (the other end is the glue flap)
  const walls: Rect[] = [];
  for (let i = 0; i + 1 < xs.length; i++) walls.push([xs[i], top, xs[i + 1], bottom]);
  if (walls.length === 3) {
    const w = walls[1][2] - walls[1][0]; // walls alternate width / depth, so the missing one matches the middle
    const tallCutAt = (x: number) =>
      page.segments.some((s) => !isFold(s) && isVertical(s) && Math.abs(s.x1 - x) <= TOL * 2 && len(s) > height * 0.7);
    const right = xs[xs.length - 1] + w;
    const left = xs[0] - w;
    if (tallCutAt(right) || !tallCutAt(left)) walls.push([xs[xs.length - 1], top, right, bottom]);
    else walls.unshift([left, top, xs[0], bottom]);
  }
  if (walls.length !== 4) throw new Error(`${walls.length} walls, need 4`);
  const widths = walls.map((w) => w[2] - w[0]);
  if (!close(widths[0], widths[2]) || !close(widths[1], widths[3])) throw new Error("opposite walls differ in width");

  // 3. Lids: horizontal folds above / below the walls
  const wallAt = (x: number) => walls.findIndex((w) => x >= w[0] - TOL && x <= w[2] + TOL);
  const horizontals = folds.filter(isHorizontal);
  const lidFold = (above: boolean) => {
    const candidates = horizontals
      .map((s) => ({ y: s.y1, mid: (s.x1 + s.x2) / 2 }))
      .filter((c) => (above ? c.y < top - TOL * 3 : c.y > bottom + TOL * 3))
      .sort((a, b) => (above ? b.y - a.y : a.y - b.y)); // nearest to the walls first
    return candidates.length ? { ...candidates[0], wall: wallAt(candidates[0].mid) } : undefined;
  };
  const topLid = lidFold(true);
  const bottomLid = lidFold(false);

  // 4. Which wall is the front? The top lid hangs from the back on a standard (reverse) tuck-end carton.
  let front: number;
  if (options.front) front = options.front - 1;
  else if (topLid && topLid.wall >= 0) front = (topLid.wall + 2) % 4;
  else if (bottomLid && bottomLid.wall >= 0) front = bottomLid.wall;
  else front = 2;

  // Walls in flat order wrap around the box: front, then right, back, left
  const faceOf = (wall: number) => WALL_ORDER[(wall - front + 4) % 4];
  const faces = {} as Record<FaceName, FaceLayout>;
  walls.forEach((rect, i) => (faces[faceOf(i)] = { rect, rotate: 0 }));

  const frontRect = faces.front.rect;
  const depthPt = faces.right.rect[2] - faces.right.rect[0];
  if (topLid && topLid.wall >= 0) {
    const w = walls[topLid.wall];
    faces.top = { rect: [w[0], topLid.y, w[2], top], rotate: TOP_ROTATION[faceOf(topLid.wall)] };
  } else {
    faces.top = { rect: [frontRect[0], top - depthPt, frontRect[2], top], rotate: 0 };
  }
  if (bottomLid && bottomLid.wall >= 0) {
    const w = walls[bottomLid.wall];
    faces.bottom = { rect: [w[0], bottom, w[2], bottomLid.y], rotate: BOTTOM_ROTATION[faceOf(bottomLid.wall)] };
  } else {
    faces.bottom = { rect: [frontRect[0], bottom, frontRect[2], bottom + depthPt], rotate: 0 };
  }

  const sample = folds[0];
  return {
    kind: "carton",
    size: { width: mm(frontRect[2] - frontRect[0]), height: mm(height), depth: mm(depthPt) },
    faces,
    walls,
    foldStyle: { color: sample.color, width: sample.width, dashed: sample.dashed },
    linesPage: page.index,
  };
}

/**
 * Find the panels of a tuck-end carton from a dieline page.
 *
 * Fold colours differ between tools (Pacdora: red folds; Templatemaker: cyan folds and crimson cuts;
 * many printers: dashed folds), so instead of trusting a colour, every line style is tried as "the folds"
 * and the one that forms a valid carton wins. Dashed styles are tried first.
 */
export function detectBox(page: PageInfo, options: DetectOptions = {}): BoxLayout {
  if (options.isCrease) return cartonFrom(page, options.isCrease, options);
  const styles = lineStyles(page.segments)
    .filter((g) => g.segments.some(isVertical))
    .sort((a, b) => Number(b.style.dashed) - Number(a.style.dashed) || b.segments.length - a.segments.length);
  const reasons: string[] = [];
  for (const { style } of styles) {
    const key = styleKey(style);
    try {
      return cartonFrom(page, (s) => styleKey(s) === key, options);
    } catch (err) {
      reasons.push(`${describe(style)}: ${(err as Error).message}`);
    }
  }
  throw new Error(`No line style forms a tuck-end carton.\n  ${reasons.join("\n  ") || "no straight lines found"}`);
}

function describe(s: LineStyle) {
  const hex = "#" + s.color.map((c) => c.toString(16).padStart(2, "0")).join("");
  return `${s.dashed ? "dashed" : "solid"} ${hex} ${s.width.toFixed(2)}pt`;
}

/** Axis-aligned rectangles drawn in a single line style (rounded corners are fine). */
function rectangles(page: PageInfo): Rect[] {
  const found: Rect[] = [];
  for (const { segments } of lineStyles(page.segments)) {
    const hs = segments.filter(isHorizontal);
    const vs = segments.filter(isVertical);
    // A style may hold several rectangles: start from each long horizontal edge pair
    const ys = cluster(hs.map((s) => ({ value: s.y1, weight: len(s) }))).map((g) => g.value);
    for (let i = 0; i < ys.length; i++) {
      for (let j = i + 1; j < ys.length; j++) {
        const [yTop, yBot] = [ys[i], ys[j]];
        const topEdges = hs.filter((s) => Math.abs(s.y1 - yTop) <= TOL);
        const botEdges = hs.filter((s) => Math.abs(s.y1 - yBot) <= TOL);
        for (const t of topEdges) {
          const [tx0, tx1] = [Math.min(t.x1, t.x2), Math.max(t.x1, t.x2)];
          const b = botEdges.find((s) => close(Math.min(s.x1, s.x2), tx0) && close(Math.max(s.x1, s.x2), tx1));
          if (!b) continue;
          // Side edges: vertical lines just outside the horizontal edges (rounded corners make them shorter)
          const h = yBot - yTop;
          const side = (x: number) =>
            vs.some((s) => Math.abs(s.x1 - x) <= h * 0.25 && len(s) >= h * 0.5 && Math.min(s.y1, s.y2) >= yTop - TOL && Math.max(s.y1, s.y2) <= yBot + TOL);
          const leftX = vs.filter((s) => s.x1 <= tx0 + TOL && s.x1 >= tx0 - h * 0.25 && len(s) >= h * 0.5).map((s) => s.x1);
          const rightX = vs.filter((s) => s.x1 >= tx1 - TOL && s.x1 <= tx1 + h * 0.25 && len(s) >= h * 0.5).map((s) => s.x1);
          if (!leftX.length || !rightX.length || !side(leftX[0]) || !side(rightX[0])) continue;
          found.push([Math.min(...leftX), yTop, Math.max(...rightX), yBot]);
        }
      }
    }
  }
  // Ignore tiny boxes (legend swatches, text frames under 15 mm)
  return found.filter((r) => (r[2] - r[0]) * PT_TO_MM >= 15 && (r[3] - r[1]) * PT_TO_MM >= 10);
}

const contains = (a: Rect, b: Rect) => a[0] < b[0] && a[1] < b[1] && a[2] > b[2] && a[3] > b[3];
const area = (r: Rect) => (r[2] - r[0]) * (r[3] - r[1]);

/**
 * Find a flat label (for bottles, jars, cans): a rectangle, usually with a bleed rectangle around it
 * and sometimes a safe-area rectangle inside. The trim is the middle one of three, or the inner one of two.
 */
export function detectLabel(page: PageInfo): LabelLayout {
  const rects = rectangles(page).sort((a, b) => area(b) - area(a));
  if (!rects.length) throw new Error("No label rectangle found.");
  // Longest chain of nested rectangles, starting from the outermost
  let best: Rect[] = [];
  for (const start of rects) {
    const chain = [start];
    for (const r of rects) if (contains(chain[chain.length - 1], r)) chain.push(r);
    if (chain.length > best.length || (chain.length === best.length && area(chain[0]) > area(best[0]))) best = chain;
  }
  const trim = best.length >= 2 ? best[1] : best[0];
  const bleed = best.length >= 2 ? best[0] : undefined;
  return {
    kind: "label",
    size: { width: mm(trim[2] - trim[0]), height: mm(trim[3] - trim[1]) },
    trim,
    bleed,
    linesPage: page.index,
  };
}

/** Work out what kind of dieline this is: a folding carton, or a flat label. */
export function detectDieline(page: PageInfo, options: DetectOptions & { kind?: "carton" | "label" } = {}): DielineLayout {
  if (options.kind === "label") return detectLabel(page);
  if (options.kind === "carton") return detectBox(page, options);
  try {
    return detectBox(page, options);
  } catch (cartonErr) {
    try {
      return detectLabel(page);
    } catch {
      throw cartonErr;
    }
  }
}

/**
 * Pick the page with the dieline lines and the page with the artwork.
 * Pacdora exports 3 pages: info + art + lines, art only, lines only.
 */
export function choosePages(pages: PageInfo[]): { lines: PageInfo; art: PageInfo } {
  const straight = (p: PageInfo) => p.segments.filter((s) => isVertical(s) || isHorizontal(s)).length;
  // Most lines wins, but prefer a clean lines-only page (no legend or artwork) when it has nearly as many
  const most = Math.max(...pages.map(straight));
  const lines = pages.filter((p) => straight(p) >= most * 0.7).sort((a, b) => a.artOps - b.artOps)[0];
  const withArt = pages.filter((p) => p.artOps > 0 && p.width === lines.width && p.height === lines.height);
  // Prefer artwork without guide lines drawn over it
  const art = withArt.sort((a, b) => a.segments.length - b.segments.length)[0] ?? lines;
  return { lines, art };
}
