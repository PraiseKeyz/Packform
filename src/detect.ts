import { detectCarton, type CartonLayout, type CartonOptions } from "./fold";
import type { BlisterLayout, PillowLayout } from "./flat";
import { analyzePanels, type Panel, type PanelAnalysis, type Point } from "./panels";
import type { PageInfo, Rect, Segment } from "./pdf";
import type { ConeLabel } from "./shapes";
import { PT_TO_MM, lineStyles, segLength, styleKey, styleOf } from "./styles";

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

export interface ConeLabelLayout extends ConeLabel {
  kind: "cone-label";
  /** Arc lengths and depth in millimetres: outer arc, inner arc, and the label's slant height. */
  size: { outer: number; inner: number; height: number };
  linesPage: number;
}

export type DielineKind = "carton" | "label" | "cone-label" | "blister" | "sachet" | "pouch";
export type DielineLayout = CartonLayout | LabelLayout | ConeLabelLayout | BlisterLayout | PillowLayout;

export interface DetectOptions extends CartonOptions {
  /** Skip auto-detection. */
  kind?: DielineKind;
}

const TOL = 3; // points (~1 mm)
const isVertical = (s: Segment) => Math.abs(s.x2 - s.x1) < 0.5 && Math.abs(s.y2 - s.y1) > 10;
const isHorizontal = (s: Segment) => Math.abs(s.y2 - s.y1) < 0.5 && Math.abs(s.x2 - s.x1) > 10;
const mm = (pt: number) => Math.round(pt * PT_TO_MM * 2) / 2; // nearest 0.5 mm
const close = (a: number, b: number, rel = 0.04) => Math.abs(a - b) <= Math.max(TOL, rel * Math.max(a, b));
const area = (r: Rect) => (r[2] - r[0]) * (r[3] - r[1]);
const contains = (a: Rect, b: Rect, tol = 0) => a[0] - tol < b[0] && a[1] - tol < b[1] && a[2] + tol > b[2] && a[3] + tol > b[3];

function cluster(values: number[], tol = TOL) {
  const sorted = [...values].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const v of sorted) {
    const g = groups[groups.length - 1];
    if (g && v - g[g.length - 1] <= tol) g.push(v);
    else groups.push([v]);
  }
  return groups.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}

/** Axis-aligned rectangles drawn in a single line style (rounded corners are fine). */
function rectangles(page: PageInfo): Rect[] {
  const found: Rect[] = [];
  for (const { segments } of lineStyles(page.segments)) {
    const hs = segments.filter((s) => isHorizontal(s) && !s.curved);
    const vs = segments.filter((s) => isVertical(s) && !s.curved);
    const ys = cluster(hs.map((s) => s.y1));
    for (let i = 0; i < ys.length; i++) {
      for (let j = i + 1; j < ys.length; j++) {
        const [yTop, yBot] = [ys[i], ys[j]];
        const h = yBot - yTop;
        for (const t of hs.filter((s) => Math.abs(s.y1 - yTop) <= TOL)) {
          const [tx0, tx1] = [Math.min(t.x1, t.x2), Math.max(t.x1, t.x2)];
          const b = hs.find((s) => Math.abs(s.y1 - yBot) <= TOL && close(Math.min(s.x1, s.x2), tx0) && close(Math.max(s.x1, s.x2), tx1));
          if (!b) continue;
          // Side edges: vertical lines at (or just outside, for rounded corners) the ends of the horizontal edges
          const sideAt = (x: number, outward: -1 | 1) =>
            vs.filter((s) => (s.x1 - x) * outward >= -TOL && (s.x1 - x) * outward <= h * 0.25 && segLength(s) >= h * 0.5 && Math.min(s.y1, s.y2) >= yTop - TOL && Math.max(s.y1, s.y2) <= yBot + TOL).map((s) => s.x1);
          const left = sideAt(tx0, -1), right = sideAt(tx1, 1);
          if (left.length && right.length) found.push([Math.min(...left), yTop, Math.max(...right), yBot]);
        }
      }
    }
  }
  // Ignore tiny boxes (legend swatches, text frames under 15 × 10 mm)
  return found.filter((r) => (r[2] - r[0]) * PT_TO_MM >= 15 && (r[3] - r[1]) * PT_TO_MM >= 10);
}

/** Groups of rectangles nested inside each other (bleed ⊃ trim ⊃ safe area), outermost first. */
function nestedChains(rects: Rect[]): Rect[][] {
  const sorted = [...rects].sort((a, b) => area(b) - area(a));
  const chains: Rect[][] = [];
  for (const r of sorted) {
    const chain = chains.find((c) => contains(c[c.length - 1], r) && area(r) > area(c[c.length - 1]) * 0.6);
    if (chain) chain.push(r);
    else if (!chains.some((c) => contains(c[0], r))) chains.push([r]);
  }
  return chains;
}
/** The trim of a nested chain: the middle of three, or the inner one of two. */
const trimOf = (chain: Rect[]) => (chain.length >= 2 ? chain[1] : chain[0]);

/**
 * A flat label (for bottles, jars, cans, tubes): a rectangle, usually with a bleed rectangle around it
 * and sometimes a safe-area rectangle inside.
 */
export function detectLabel(page: PageInfo): LabelLayout {
  const chains = nestedChains(rectangles(page));
  if (!chains.length) throw new Error("No label rectangle found.");
  const best = [...chains].sort((a, b) => b.length - a.length || area(b[0]) - area(a[0]))[0];
  const trim = trimOf(best);
  return {
    kind: "label",
    size: { width: mm(trim[2] - trim[0]), height: mm(trim[3] - trim[1]) },
    trim,
    bleed: best.length >= 2 ? best[0] : undefined,
    linesPage: page.index,
  };
}

/** Fit a circle to points (algebraic least squares). */
function fitCircle(pts: Point[]) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
  }
  const n = pts.length;
  // Solve [sxx sxy sx; sxy syy sy; sx sy n] [D E F]ᵀ = -[sxz syz sz]ᵀ
  const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], b = [-sxz, -syz, -sz];
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(A);
  if (Math.abs(d) < 1e-9) return undefined;
  const col = (k: number) => A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)));
  const [D, E, F] = [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
  const cx = -D / 2, cy = -E / 2, r = Math.sqrt(Math.max(0, cx * cx + cy * cy - F));
  const rms = Math.sqrt(pts.reduce((s, [x, y]) => s + (Math.hypot(x - cx, y - cy) - r) ** 2, 0) / n);
  return { cx, cy, r, rms };
}

/** A curved label for a tapered cup or tub: two concentric arcs joined by two straight ends. */
export function detectConeLabel(page: PageInfo): ConeLabelLayout {
  // Runs of consecutive curved pieces within each drawn path are candidate arcs
  const arcs: { cx: number; cy: number; r: number; a0: number; a1: number; pts: Point[]; style: string }[] = [];
  const byPath = new Map<number, Segment[]>();
  for (const s of page.segments) if (s.curved) byPath.set(s.path, [...(byPath.get(s.path) ?? []), s]);
  for (const segs of byPath.values()) {
    let run: Segment[] = [];
    const flush = () => {
      if (run.length >= 6) {
        const pts: Point[] = [[run[0].x1, run[0].y1], ...run.map((s) => [s.x2, s.y2] as Point)];
        const c = fitCircle(pts);
        if (c && c.r > 30 && c.rms < 0.6) {
          const angs = pts.map(([x, y]) => Math.atan2(y - c.cy, x - c.cx));
          // unwrap so the run's angles are continuous
          for (let i = 1; i < angs.length; i++) while (angs[i] - angs[i - 1] > Math.PI) angs[i] -= 2 * Math.PI;
          for (let i = 1; i < angs.length; i++) while (angs[i] - angs[i - 1] < -Math.PI) angs[i] += 2 * Math.PI;
          const span = Math.abs(angs[angs.length - 1] - angs[0]);
          if (span > 0.2 && span < 2 * Math.PI - 0.2) arcs.push({ ...c, a0: angs[0], a1: angs[angs.length - 1], pts, style: styleKey(styleOf(run[0])) });
        }
      }
      run = [];
    };
    for (const s of segs) {
      const prev = run[run.length - 1];
      if (prev && Math.hypot(prev.x2 - s.x1, prev.y2 - s.y1) > 0.5) flush();
      run.push(s);
    }
    flush();
  }
  // Merge arcs that continue each other on the same circle (one arc is usually several curves)
  const merged: typeof arcs = [];
  for (const a of arcs) {
    const m = merged.find((b) => b.style === a.style && Math.hypot(a.cx - b.cx, a.cy - b.cy) < 3 && Math.abs(a.r - b.r) < 2);
    if (m) {
      const all = [...m.pts, ...a.pts];
      const c = fitCircle(all)!;
      const angs = all.map(([x, y]) => Math.atan2(y - c.cy, x - c.cx));
      const ref = angs[0];
      const rel = angs.map((v) => ((v - ref + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      Object.assign(m, c, { pts: all, a0: ref + Math.min(...rel), a1: ref + Math.max(...rel) });
    } else merged.push({ ...a });
  }
  // Pairs of concentric arcs in the same line style = a sector; the widest is usually the bleed
  const sectors: { cx: number; cy: number; r1: number; r2: number; a0: number; a1: number }[] = [];
  for (let i = 0; i < merged.length; i++)
    for (let j = 0; j < merged.length; j++) {
      const [a, b] = [merged[i], merged[j]];
      if (i === j || a.style !== b.style || a.r >= b.r || Math.hypot(a.cx - b.cx, a.cy - b.cy) > 3 || b.r - a.r < 15) continue;
      const lo = Math.max(Math.min(a.a0, a.a1), Math.min(b.a0, b.a1)), hi = Math.min(Math.max(a.a0, a.a1), Math.max(b.a0, b.a1));
      const spanA = Math.abs(a.a1 - a.a0), spanB = Math.abs(b.a1 - b.a0);
      if (hi - lo < 0.8 * Math.min(spanA, spanB)) continue;
      sectors.push({ cx: (a.cx + b.cx) / 2, cy: (a.cy + b.cy) / 2, r1: a.r, r2: b.r, a0: Math.min(a.a0, a.a1, b.a0, b.a1), a1: Math.max(a.a0, a.a1, b.a0, b.a1) });
    }
  if (!sectors.length) throw new Error("No curved (cone) label found.");
  sectors.sort((p, q) => q.r2 - q.r1 - (p.r2 - p.r1));
  // The trim is the widest sector sharing neither arc with the bleed. When cut and bleed are drawn in one style,
  // the pairs mixing a bleed arc with a cut arc are sectors too, and must not be taken for the trim.
  const [bleed] = sectors;
  const sameArc = (a: number, b: number) => Math.abs(a - b) < 2;
  const s = sectors.find((c) => !sameArc(c.r1, bleed.r1) && !sameArc(c.r2, bleed.r2)) ?? bleed;
  // Page area the sector covers
  const pts: Point[] = [];
  for (let k = 0; k <= 32; k++) {
    const a = s.a0 + ((s.a1 - s.a0) * k) / 32;
    pts.push([s.cx + Math.cos(a) * s.r1, s.cy + Math.sin(a) * s.r1], [s.cx + Math.cos(a) * s.r2, s.cy + Math.sin(a) * s.r2]);
  }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const span = s.a1 - s.a0;
  return {
    kind: "cone-label",
    center: [s.cx, s.cy],
    r1: s.r1,
    r2: s.r2,
    a0: s.a0,
    a1: s.a1,
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    size: { outer: mm(s.r2 * span), inner: mm(s.r1 * span), height: mm(s.r2 - s.r1) },
    linesPage: page.index,
  };
}

const sizeOf = (r: Rect) => ({ width: mm(r[2] - r[0]), height: mm(r[3] - r[1]) });
const similar = (a: Panel, b: Panel, rel = 0.05) => close(a.bbox[2] - a.bbox[0], b.bbox[2] - b.bbox[0], rel) && close(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1], rel);

/** A blister pack: a card or foil with two or more similar pockets (cavities) inside it. */
export function detectBlister(page: PageInfo, analysis = analyzePanels(page)): BlisterLayout {
  const panels = [...analysis.panels].sort((a, b) => b.area - a.area);
  for (const card of panels) {
    const inside = panels.filter((p) => p !== card && contains(card.bbox, p.bbox) && p.area < card.area / 6);
    if (inside.length < 2) continue;
    // The largest group of similar cavities
    const groups = inside.map((p) => inside.filter((q) => similar(p, q, 0.15)));
    const cav = groups.sort((a, b) => b.length - a.length)[0];
    if (cav.length < 2) continue;
    return {
      kind: "blister",
      card: card.polygon,
      cardBox: card.bbox,
      cavities: cav.map((p) => ({ box: p.bbox, fill: p.area / area(p.bbox) })),
      size: sizeOf(card.bbox),
      linesPage: page.index,
    };
  }
  throw new Error("No blister card with cavities found.");
}

/**
 * A sachet (front and back panels side by side, or just a front) or a stand-up pouch
 * (front and back with a bottom gusset folded between them).
 */
export function detectPillow(page: PageInfo, kind?: "sachet" | "pouch", analysis: PanelAnalysis = analyzePanels(page)): PillowLayout {
  const panels = [...analysis.panels].sort((a, b) => b.area - a.area);
  if (!panels.length) throw new Error("No sachet or pouch panels found.");
  const big = panels[0];
  // front/back: the biggest panel and another the same size, side by side; front = the left (or upper) one
  const twin = panels.find((p) => p !== big && similar(p, big) && !contains(big.bbox, p.bbox));
  const [front, back] = twin ? ([big, twin].sort((a, b) => a.bbox[0] - b.bbox[0] || a.bbox[1] - b.bbox[1]) as [Panel, Panel]) : [big, undefined];
  // A gusset: a smaller panel folded onto the bottom of the front or back
  const below = (p: Panel, q: Panel) => Math.abs(q.bbox[1] - p.bbox[3]) < 4 && q.bbox[0] < p.bbox[2] && q.bbox[2] > p.bbox[0];
  const gusset = panels.find((p) => p !== front && p !== back && p.area < big.area * 0.5 && (below(front, p) || (back && below(back, p))) && analysis.hinges.some((h) => [h.a, h.b].includes(p.id)));
  const k = kind ?? (gusset ? "pouch" : "sachet");
  if (!kind && !twin && !gusset) throw new Error("Only one panel: pass kind \"sachet\" to make it a sachet.");
  return { kind: k, front: front.bbox, back: back?.bbox, gusset: gusset?.bbox, size: sizeOf(front.bbox), linesPage: page.index };
}

/**
 * Work out what a dieline is. Cartons are tried first (panels joined by folds), then curved cup labels,
 * blister packs, pouches and sachets, and finally plain wrap-around labels.
 */
export function detectDieline(page: PageInfo, options: DetectOptions = {}): DielineLayout {
  const { kind } = options;
  if (kind === "carton") return detectCarton(page, options);
  if (kind === "label") return detectLabel(page);
  if (kind === "cone-label") return detectConeLabel(page);
  if (kind === "blister") return detectBlister(page);
  if (kind === "sachet" || kind === "pouch") return detectPillow(page, kind);

  const reasons: string[] = [];
  const attempt = <T>(name: string, f: () => T): T | undefined => {
    try {
      return f();
    } catch (err) {
      reasons.push(`${name}: ${(err as Error).message}`);
      return undefined;
    }
  };
  const analysis = analyzePanels(page);
  return (
    attempt("carton", () => detectCarton(page, options, analysis)) ??
    attempt("cone label", () => detectConeLabel(page)) ??
    attempt("blister", () => detectBlister(page, analysis)) ??
    attempt("pouch/sachet", () => detectPillow(page, undefined, analysis)) ??
    attempt("label", () => detectLabel(page)) ??
    (() => {
      throw new Error(`Couldn't recognise this dieline.\n  ${reasons.join("\n  ")}\nTry --kind to say what it is.`);
    })()
  );
}

/**
 * Pick the page with the dieline lines and the page with the artwork. Multi-page exports often have
 * a cover page (info, artwork and lines), an artwork-only page and a lines-only page.
 */
export function choosePages(pages: PageInfo[]): { lines: PageInfo; art: PageInfo } {
  const count = (p: PageInfo) => p.segments.filter((s) => segLength(s) > 2).length;
  // Most lines wins, but prefer a clean lines-only page (no artwork, legend or info box) when it has a good share of them
  const most = Math.max(...pages.map(count));
  const lines = pages.filter((p) => count(p) >= most * 0.5).sort((a, b) => a.artOps - b.artOps || count(b) - count(a))[0];
  const withArt = pages.filter((p) => p.artOps > 0 && p.width === lines.width && p.height === lines.height);
  // Prefer artwork without guide lines drawn over it
  const art = withArt.sort((a, b) => a.segments.length - b.segments.length)[0] ?? lines;
  return { lines, art };
}
