/**
 * Generate the test dielines in fixtures/. They are drawn from scratch (no third-party artwork), so they can be shared.
 *
 *   npx tsx scripts/make-fixtures.ts
 *
 * Panels are painted known colours so tests can check that every panel lands in the right place, the right way up.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { FACE_COLORS, FIXTURE_SIZES as S, FLAT_COLORS, LABEL_COLORS } from "../test/colors";

const MM = 72 / 25.4;
const OUT = new URL("../fixtures/", import.meta.url);
const c = (v: readonly number[]): RGB => rgb(v[0] / 255, v[1] / 255, v[2] / 255);

interface LineStyleSpec {
  color: RGB;
  width: number;
  dash?: number[];
}
const RED_FOLD: LineStyleSpec = { color: rgb(0.97, 0.25, 0.2), width: 1 };
const DARK_CUT: LineStyleSpec = { color: rgb(0.2, 0.2, 0.4), width: 1 };
const CYAN_FOLD: LineStyleSpec = { color: rgb(0, 0.67, 0.93), width: 0.75 };
const CRIMSON_CUT: LineStyleSpec = { color: rgb(0.83, 0.1, 0.35), width: 2 };
const DASHED_FOLD: LineStyleSpec = { color: rgb(0, 0, 0), width: 0.5, dash: [4, 3] };
const BLACK_CUT: LineStyleSpec = { color: rgb(0, 0, 0), width: 0.5 };
const RED_CUT: LineStyleSpec = { color: rgb(0.9, 0.1, 0.12), width: 1 };
const GREEN_BLEED: LineStyleSpec = { color: rgb(0.4, 0.75, 0.3), width: 1 };

/** A panel of a net, in mm from the top-left of the net. */
interface PanelSpec {
  r: [number, number, number, number];
  color: readonly number[];
  text?: string;
  /** Paint the half next to this edge in another colour (to check lid orientation). */
  split?: { edge: "top" | "bottom"; color: readonly number[] };
}

class Sheet {
  pdf!: PDFDocument;
  page!: PDFPage;
  font!: PDFFont;
  constructor(readonly w: number, readonly h: number, readonly margin = 20) {}
  async init() {
    this.pdf = await PDFDocument.create();
    this.page = this.pdf.addPage([(this.w + 2 * this.margin) * MM, (this.h + 2 * this.margin) * MM]);
    this.font = await this.pdf.embedFont(StandardFonts.HelveticaBold);
    return this;
  }
  /** mm (top-left origin, inside the margin) → PDF points (bottom-left origin) */
  X = (x: number) => (x + this.margin) * MM;
  Y = (y: number) => this.page.getHeight() - (y + this.margin) * MM;
  rect(r: [number, number, number, number], color: readonly number[]) {
    this.page.drawRectangle({ x: this.X(r[0]), y: this.Y(r[3]), width: (r[2] - r[0]) * MM, height: (r[3] - r[1]) * MM, color: c(color) });
  }
  text(s: string, r: [number, number, number, number]) {
    const w = (r[2] - r[0]) * MM, h = (r[3] - r[1]) * MM;
    const size = Math.min(w / (s.length * 0.62), h * 0.3, 28);
    const tw = this.font.widthOfTextAtSize(s, size);
    this.page.drawText(s, { x: this.X(r[0]) + (w - tw) / 2, y: this.Y(r[1]) - h / 2 - size / 3, size, font: this.font, color: rgb(1, 1, 1) });
  }
  line(st: LineStyleSpec, a: [number, number], b: [number, number]) {
    this.page.drawLine({ start: { x: this.X(a[0]), y: this.Y(a[1]) }, end: { x: this.X(b[0]), y: this.Y(b[1]) }, color: st.color, thickness: st.width, dashArray: st.dash });
  }
  svg(path: string, opts: { fill?: readonly number[]; stroke?: LineStyleSpec }) {
    // path in mm, top-left origin of the net
    this.page.drawSvgPath(path, {
      x: this.X(0),
      y: this.Y(0),
      scale: MM,
      color: opts.fill ? c(opts.fill) : undefined,
      borderColor: opts.stroke?.color,
      borderWidth: opts.stroke ? opts.stroke.width / MM : undefined,
      borderDashArray: opts.stroke?.dash?.map((d) => d / MM),
    });
  }
  async save(name: string) {
    writeFileSync(new URL(name, OUT), await this.pdf.save());
  }
}

/**
 * Draw a net of rectangular panels: every panel edge shared with another panel becomes a fold, every other edge a cut.
 * (Neighbouring flaps that must not be joined are drawn with a small gap.)
 */
async function net(name: string, panels: PanelSpec[], fold: LineStyleSpec, cut: LineStyleSpec, extraFolds: [number, number][][] = []) {
  const W = Math.max(...panels.map((p) => p.r[2])), H = Math.max(...panels.map((p) => p.r[3]));
  const sheet = await new Sheet(W, H).init();
  for (const p of panels) {
    sheet.rect(p.r, p.color);
    if (p.split) {
      const [x0, y0, x1, y1] = p.r, mid = (y0 + y1) / 2;
      sheet.rect(p.split.edge === "top" ? [x0, y0, x1, mid] : [x0, mid, x1, y1], p.split.color);
    }
    if (p.text) sheet.text(p.text, p.r);
  }
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  // Split each edge into the parts shared with another panel (folds) and the rest (cuts)
  panels.forEach((p, i) => {
    const [x0, y0, x1, y1] = p.r;
    const edges: { horizontal: boolean; at: number; from: number; to: number }[] = [
      { horizontal: true, at: y0, from: x0, to: x1 },
      { horizontal: true, at: y1, from: x0, to: x1 },
      { horizontal: false, at: x0, from: y0, to: y1 },
      { horizontal: false, at: x1, from: y0, to: y1 },
    ];
    for (const e of edges) {
      const shared: [number, number, number][] = [];
      panels.forEach((q, j) => {
        if (j === i) return;
        const [qx0, qy0, qx1, qy1] = q.r;
        const touches = e.horizontal ? eq(qy0, e.at) || eq(qy1, e.at) : eq(qx0, e.at) || eq(qx1, e.at);
        if (!touches) return;
        const lo = Math.max(e.from, e.horizontal ? qx0 : qy0), hi = Math.min(e.to, e.horizontal ? qx1 : qy1);
        if (hi - lo > 0.5) shared.push([lo, hi, j]);
      });
      shared.sort((a, b) => a[0] - b[0]);
      let pos = e.from;
      const draw = (st: LineStyleSpec, a: number, b: number) =>
        sheet.line(st, e.horizontal ? [a, e.at] : [e.at, a], e.horizontal ? [b, e.at] : [e.at, b]);
      for (const [lo, hi, j] of shared) {
        if (lo > pos) draw(cut, pos, lo);
        if (i < j) draw(fold, lo, hi); // draw each fold once
        pos = Math.max(pos, hi);
      }
      if (pos < e.to) draw(cut, pos, e.to);
    }
  });
  for (const pl of extraFolds) pl.slice(1).forEach((p, k) => sheet.line(fold, pl[k], p));
  await sheet.save(name);
}

/** Tuck-end carton: glue flap, back, left, front, right; top lid + tuck on the back, bottom lid + tuck on the front. */
function tuckEnd(): PanelSpec[] {
  const { w: W, h: H, d: D } = S.tuckEnd;
  const glue = 15, tuck = 15, top = tuck + D;
  const xs = [glue, glue + W, glue + W + D, glue + 2 * W + D, glue + 2 * W + 2 * D];
  const dust = D * 0.6, g = 2;
  return [
    { r: [0, top + 5, glue, top + H - 5], color: [200, 200, 200] },
    { r: [xs[0], top, xs[1], top + H], color: FACE_COLORS.back, text: "BACK" },
    { r: [xs[1], top, xs[2], top + H], color: FACE_COLORS.left, text: "LEFT" },
    { r: [xs[2], top, xs[3], top + H], color: FACE_COLORS.front, text: "FRONT" },
    { r: [xs[3], top, xs[4], top + H], color: FACE_COLORS.right, text: "RIGHT" },
    { r: [xs[0], tuck, xs[1], top], color: FACE_COLORS.topFar, split: { edge: "bottom", color: FACE_COLORS.topHinge } },
    { r: [xs[0] + 3, 0, xs[1] - 3, tuck], color: [210, 210, 210] },
    { r: [xs[2], top + H, xs[3], top + H + D], color: FACE_COLORS.bottomFar, split: { edge: "top", color: FACE_COLORS.bottomHinge } },
    { r: [xs[2] + 3, top + H + D, xs[3] - 3, top + H + D + tuck], color: [210, 210, 210] },
    { r: [xs[1] + g, top - dust, xs[2] - g, top], color: [180, 180, 180] },
    { r: [xs[3] + g, top - dust, xs[4] - g, top], color: [180, 180, 180] },
    { r: [xs[1] + g, top + H, xs[2] - g, top + H + dust], color: [180, 180, 180] },
    { r: [xs[3] + g, top + H, xs[4] - g, top + H + dust], color: [180, 180, 180] },
  ];
}

/** Tray: base with four walls and four corner flaps (glued inside the short walls). */
function tray(): PanelSpec[] {
  const { l: L, w: W, h } = S.tray;
  const f = h * 0.8, gap = 1.5;
  return [
    { r: [h, h, h + L, h + W], color: FLAT_COLORS.base, text: "BASE" },
    { r: [h, 0, h + L, h], color: FLAT_COLORS.wall, text: "BACK" },
    { r: [h, h + W, h + L, h + W + h], color: FLAT_COLORS.wall, text: "FRONT" },
    { r: [0, h, h, h + W], color: FLAT_COLORS.wall },
    { r: [h + L, h, h + L + h, h + W], color: FLAT_COLORS.wall },
    { r: [h - f, 0, h, h - gap], color: FLAT_COLORS.flap },
    { r: [h + L, 0, h + L + f, h - gap], color: FLAT_COLORS.flap },
    { r: [h - f, h + W + gap, h, h + W + h], color: FLAT_COLORS.flap },
    { r: [h + L, h + W + gap, h + L + f, h + W + h], color: FLAT_COLORS.flap },
  ];
}

/** Mailer box: base, double front wall (front, rim, inner), side walls, back wall, lid with a tuck and side flaps. */
function mailer(): PanelSpec[] {
  const { w: W, l: L, h } = S.mailer;
  const tk = h * 0.9, rim = 4, side = h * 0.9, gap = 2;
  const x0 = h, x1 = h + W;
  const yLid = tk, yBack = yLid + L, yBase = yBack + h, yFront = yBase + L, yRim = yFront + h, yInner = yRim + rim;
  return [
    { r: [x0, yBase, x1, yFront], color: FLAT_COLORS.base, text: "BASE" },
    { r: [x0, yBack, x1, yBase], color: FLAT_COLORS.wall },
    { r: [x0, yLid, x1, yBack], color: FLAT_COLORS.lid, text: "LID" },
    { r: [x0 + 4, 0, x1 - 4, yLid], color: FLAT_COLORS.flap },
    { r: [x0 - side, yLid + gap, x0, yBack - gap], color: FLAT_COLORS.flap },
    { r: [x1, yLid + gap, x1 + side, yBack - gap], color: FLAT_COLORS.flap },
    { r: [0, yBase, x0, yFront], color: FLAT_COLORS.wall },
    { r: [x1, yBase, x1 + h, yFront], color: FLAT_COLORS.wall },
    { r: [x0, yFront, x1, yRim], color: FLAT_COLORS.wall, text: "FRONT" },
    { r: [x0, yRim, x1, yInner], color: FLAT_COLORS.flap },
    { r: [x0, yInner, x1, yInner + h], color: FLAT_COLORS.wall },
  ];
}

/** Sleeve: glue flap and four walls, open at both ends. */
function sleeve(): PanelSpec[] {
  const { w: W, h: H, d: D } = S.sleeve;
  const glue = 12;
  const xs = [glue, glue + W, glue + W + D, glue + 2 * W + D, glue + 2 * W + 2 * D];
  return [
    { r: [0, 4, glue, H - 4], color: [200, 200, 200] },
    { r: [xs[0], 0, xs[1], H], color: FACE_COLORS.front, text: "FRONT" },
    { r: [xs[1], 0, xs[2], H], color: FACE_COLORS.right },
    { r: [xs[2], 0, xs[3], H], color: FACE_COLORS.back, text: "BACK" },
    { r: [xs[3], 0, xs[4], H], color: FACE_COLORS.left },
  ];
}

/** Crash-lock (auto-bottom) carton: tuck lid on top, four bottom flaps with diagonal glue folds. */
function crashLock(): { panels: PanelSpec[]; diagonals: [number, number][][] } {
  const { w: W, h: H, d: D } = S.crashLock;
  const glue = 15, tuck = 15, top = tuck + D;
  const xs = [glue, glue + W, glue + W + D, glue + 2 * W + D, glue + 2 * W + 2 * D];
  const dust = D * 0.6, g = 2, yb = top + H, fh = D * 0.75;
  const panels: PanelSpec[] = [
    { r: [0, top + 5, glue, yb - 5], color: [200, 200, 200] },
    { r: [xs[0], top, xs[1], yb], color: FACE_COLORS.back, text: "BACK" },
    { r: [xs[1], top, xs[2], yb], color: FACE_COLORS.left },
    { r: [xs[2], top, xs[3], yb], color: FACE_COLORS.front, text: "FRONT" },
    { r: [xs[3], top, xs[4], yb], color: FACE_COLORS.right },
    { r: [xs[0], tuck, xs[1], top], color: FACE_COLORS.topFar, split: { edge: "bottom", color: FACE_COLORS.topHinge } },
    { r: [xs[0] + 3, 0, xs[1] - 3, tuck], color: [210, 210, 210] },
    { r: [xs[1] + g, top - dust, xs[2] - g, top], color: [180, 180, 180] },
    { r: [xs[3] + g, top - dust, xs[4] - g, top], color: [180, 180, 180] },
  ];
  const diagonals: [number, number][][] = [];
  for (let k = 0; k < 4; k++) {
    const [a, b] = [xs[k] + g, xs[k + 1] - g];
    panels.push({ r: [a, yb, b, yb + fh], color: [160, 160, 160] });
    diagonals.push([[a, yb], [a + Math.min(fh, b - a) * 0.8, yb + Math.min(fh, b - a) * 0.8]]);
  }
  return { panels, diagonals };
}

/** A wrap-around bottle label: green bleed, red trim, artwork in three colour bands. */
async function label(name: string) {
  const { w: W, h: H } = S.label;
  const bleed = 3;
  const sheet = await new Sheet(W + 2 * bleed, H + 2 * bleed, 25).init();
  const third = (W + 2 * bleed) / 3;
  [LABEL_COLORS.left, LABEL_COLORS.middle, LABEL_COLORS.right].forEach((col, i) => sheet.rect([i * third, 0, (i + 1) * third, H + 2 * bleed], col));
  sheet.rect([0, 0, W + 2 * bleed, bleed + H * 0.2], LABEL_COLORS.topStrip);
  sheet.text("SAMPLE WATER", [bleed, bleed + H * 0.3, bleed + W, bleed + H]);
  const box = (st: LineStyleSpec, r: [number, number, number, number]) =>
    sheet.svg(`M ${r[0]} ${r[1]} H ${r[2]} V ${r[3]} H ${r[0]} Z`, { stroke: st });
  box(GREEN_BLEED, [0, 0, W + 2 * bleed, H + 2 * bleed]);
  box(RED_CUT, [bleed, bleed, bleed + W, bleed + H]);
  await sheet.save(name);
}

/** A curved cup label: an annular sector, with a bleed sector around it (drawn in its own style unless given the cut's). */
async function cupLabel(name: string, bleedStyle: LineStyleSpec = GREEN_BLEED) {
  const { top, bottom, height } = S.cup;
  const Rt = top / 2, Rb = bottom / 2;
  const slant = Math.hypot(height, Rt - Rb);
  const r1 = (slant * Rb) / (Rt - Rb), r2 = r1 + slant; // unrolled radii (mm)
  const phi = (2 * Math.PI * Rt) / r2;
  const pad = 3, b = 3, extra = b / r2;
  const chord = 2 * (r2 + b) * Math.sin(phi / 2 + extra);
  const W = chord + 2 * pad, Htot = r2 + b - (r1 - b) * Math.cos(phi / 2 + extra) + 2 * pad;
  const sheet = await new Sheet(W, Htot, 15).init();
  const cx = W / 2, cy = pad + r2 + b; // centre below the label: arcs bow upwards, wide end up
  const P = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(3)} ${(cy + r * Math.sin(a)).toFixed(3)}`;
  const sector = (ra: number, rb: number, a0: number, a1: number) =>
    `M ${P(rb, a0)} A ${rb} ${rb} 0 0 1 ${P(rb, a1)} L ${P(ra, a1)} A ${ra} ${ra} 0 0 0 ${P(ra, a0)} Z`;
  const mid = -Math.PI / 2;
  // artwork: three bands left to right, a strip along the wide (top) edge
  const bands = [LABEL_COLORS.left, LABEL_COLORS.middle, LABEL_COLORS.right];
  const lo = mid - phi / 2 - extra, hi = mid + phi / 2 + extra;
  bands.forEach((col, i) => sheet.svg(sector(r1 - b, r2 + b, lo + ((hi - lo) * i) / 3, lo + ((hi - lo) * (i + 1)) / 3), { fill: col }));
  sheet.svg(sector(r2 - slant * 0.18, r2 + b, lo, hi), { fill: LABEL_COLORS.topStrip });
  sheet.svg(sector(r1 - b, r2 + b, lo, hi), { stroke: bleedStyle });
  sheet.svg(sector(r1, r2, mid - phi / 2, mid + phi / 2), { stroke: RED_CUT });
  await sheet.save(name);
}

/** Blister card: rounded card with rows of round cavities. */
async function blister(name: string) {
  const { w: W, h: H, rows, cols, cavity } = S.blister;
  const sheet = await new Sheet(W, H, 15).init();
  sheet.rect([0, 0, W, H], FLAT_COLORS.blister);
  sheet.text("SAMPLE TABS 10 × 500 mg", [0, H * 0.82, W, H]);
  const r = 4;
  sheet.svg(`M ${r} 0 H ${W - r} A ${r} ${r} 0 0 1 ${W} ${r} V ${H - r} A ${r} ${r} 0 0 1 ${W - r} ${H} H ${r} A ${r} ${r} 0 0 1 0 ${H - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`, { stroke: BLACK_CUT });
  const cavityLine: LineStyleSpec = { color: rgb(0.1, 0.3, 0.9), width: 0.75 };
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      const cx = (W / cols) * (j + 0.5), cy = (H * 0.8 / rows) * (i + 0.5) + 2;
      const k = cavity / 2;
      sheet.svg(`M ${cx - k} ${cy} A ${k} ${k} 0 1 1 ${cx + k} ${cy} A ${k} ${k} 0 1 1 ${cx - k} ${cy} Z`, { fill: [255, 255, 255], stroke: cavityLine });
    }
  await sheet.save(name);
}

/** Sachet: front and back side by side, each with bleed and trim. */
async function sachet(name: string) {
  const { w: W, h: H } = S.sachet;
  const b = 3, gap = 12;
  const sheet = await new Sheet(2 * W + gap + 2 * b, H + 2 * b, 15).init();
  for (const [k, col, text] of [[0, FLAT_COLORS.sachetFront, "FRONT"], [1, FLAT_COLORS.sachetBack, "BACK"]] as const) {
    const x = b + k * (W + gap);
    sheet.rect([x - b, 0, x + W + b, H + 2 * b], col);
    sheet.text(text, [x, b, x + W, b + H]);
    const box = (st: LineStyleSpec, r: number[]) => sheet.svg(`M ${r[0]} ${r[1]} H ${r[2]} V ${r[3]} H ${r[0]} Z`, { stroke: st });
    box(GREEN_BLEED, [x - b, 0, x + W + b, H + 2 * b]);
    box(RED_CUT, [x, b, x + W, b + H]);
  }
  await sheet.save(name);
}

/** Stand-up pouch: front and back side by side, each with half of the bottom gusset folded below it. */
async function pouch(name: string) {
  const { w: W, h: H, gusset: G } = S.pouch;
  const gap = 12;
  const panels: PanelSpec[] = [
    { r: [0, 0, W, H], color: FLAT_COLORS.sachetFront, text: "FRONT" },
    { r: [0, H, W, H + G / 2], color: FLAT_COLORS.gusset },
    { r: [W + gap, 0, 2 * W + gap, H], color: FLAT_COLORS.sachetBack, text: "BACK" },
    { r: [W + gap, H, 2 * W + gap, H + G / 2], color: FLAT_COLORS.gusset },
  ];
  await net(name, panels, DASHED_FOLD, BLACK_CUT);
}

mkdirSync(OUT, { recursive: true });
await net("carton-red-folds.pdf", tuckEnd(), RED_FOLD, DARK_CUT);
await net("carton-cyan-folds.pdf", tuckEnd(), CYAN_FOLD, CRIMSON_CUT);
await net("carton-dashed-folds.pdf", tuckEnd(), DASHED_FOLD, BLACK_CUT);
await net("tray.pdf", tray(), RED_FOLD, DARK_CUT);
await net("mailer.pdf", mailer(), DASHED_FOLD, BLACK_CUT);
await net("sleeve.pdf", sleeve(), CYAN_FOLD, CRIMSON_CUT);
const cl = crashLock();
await net("crash-lock.pdf", cl.panels, RED_FOLD, DARK_CUT, cl.diagonals);
await label("bottle-label.pdf");
await cupLabel("cup-label.pdf");
await cupLabel("cup-label-one-style.pdf", RED_CUT);
await blister("blister.pdf");
await sachet("sachet.pdf");
await pouch("pouch.pdf");
console.log("fixtures written");
