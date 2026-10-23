/**
 * Generate the test dielines in fixtures/. They are drawn from scratch (no third-party artwork), so they can be shared.
 *
 *   npx tsx scripts/make-fixtures.ts
 *
 * Each carton face is painted a known colour and the top/bottom lids are split in two halves,
 * so tests can check that every panel lands on the right face, the right way up.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb, type RGB } from "pdf-lib";
import { FACE_COLORS, LABEL_COLORS } from "../test/colors";

const MM = 72 / 25.4;
const OUT = new URL("../fixtures/", import.meta.url);

const c = (v: readonly number[]): RGB => rgb(v[0] / 255, v[1] / 255, v[2] / 255);

interface LineStyleSpec {
  color: RGB;
  width: number;
  dash?: number[];
}

/** A tuck-end carton laid out like Pacdora/Templatemaker: glue flap, back, left, front, right; lids on back (top) and front (bottom). */
async function carton(name: string, sizeMm: { w: number; h: number; d: number }, fold: LineStyleSpec, cut: LineStyleSpec) {
  const W = sizeMm.w * MM, H = sizeMm.h * MM, D = sizeMm.d * MM;
  const glue = 15 * MM, tuck = 15 * MM, margin = 20 * MM;
  const pageW = margin * 2 + glue + 2 * W + 2 * D;
  const pageH = margin * 2 + 2 * (D + tuck) + H;
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([pageW, pageH]);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);

  // pdf-lib uses a bottom-left origin; work top-down and flip
  const Y = (y: number) => pageH - y;
  const x0 = margin + glue;
  const xs = [x0, x0 + W, x0 + W + D, x0 + 2 * W + D, x0 + 2 * W + 2 * D];
  const yTop = margin + tuck + D, yBot = yTop + H;

  const box = (x: number, y: number, w: number, h: number, color: readonly number[]) =>
    page.drawRectangle({ x, y: Y(y + h), width: w, height: h, color: c(color) });
  const label = (text: string, x: number, y: number, w: number, h: number, rotate = 0) => {
    const size = Math.min(w, h) * 0.22;
    const tw = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: x + (w - tw) / 2, y: Y(y + h / 2 + size / 3), size, font, color: rgb(1, 1, 1), rotate: { type: "degrees" as any, angle: rotate } });
  };

  // Artwork
  const walls = [
    ["BACK", FACE_COLORS.back, xs[0], W],
    ["LEFT", FACE_COLORS.left, xs[1], D],
    ["FRONT", FACE_COLORS.front, xs[2], W],
    ["RIGHT", FACE_COLORS.right, xs[3], D],
  ] as const;
  for (const [text, color, x, w] of walls) {
    box(x, yTop, w, H, color);
    label(text, x, yTop, w, H);
  }
  // Top lid on the back wall: hinge half (nearest the wall) and far half
  box(xs[0], yTop - D / 2, W, D / 2, FACE_COLORS.topHinge);
  box(xs[0], yTop - D, W, D / 2, FACE_COLORS.topFar);
  // Bottom lid on the front wall
  box(xs[2], yBot, W, D / 2, FACE_COLORS.bottomHinge);
  box(xs[2], yBot + D / 2, W, D / 2, FACE_COLORS.bottomFar);

  // Lines
  const line = (s: LineStyleSpec, a: [number, number], b: [number, number]) =>
    page.drawLine({ start: { x: a[0], y: Y(a[1]) }, end: { x: b[0], y: Y(b[1]) }, color: s.color, thickness: s.width, dashArray: s.dash });
  const poly = (s: LineStyleSpec, pts: [number, number][]) => pts.slice(1).forEach((p, i) => line(s, pts[i], p));

  // Folds: wall folds, the top and bottom edges of the walls, and the lid-to-tuck folds
  for (const x of xs.slice(0, 4)) line(fold, [x, yTop], [x, yBot]);
  line(fold, [xs[0], yTop], [xs[4], yTop]);
  line(fold, [xs[0], yBot], [xs[4], yBot]);
  line(fold, [xs[0], yTop - D], [xs[1], yTop - D]);
  line(fold, [xs[2], yBot + D], [xs[3], yBot + D]);

  // Cuts: outline of glue flap, lids, tucks, dust flaps and the far edge
  poly(cut, [[xs[0], yTop], [margin, yTop + 5 * MM], [margin, yBot - 5 * MM], [xs[0], yBot]]); // glue flap
  poly(cut, [[xs[0], yTop], [xs[0], yTop - D], [xs[0] + 3 * MM, yTop - D - tuck], [xs[1] - 3 * MM, yTop - D - tuck], [xs[1], yTop - D], [xs[1], yTop]]); // top lid + tuck
  poly(cut, [[xs[2], yBot], [xs[2], yBot + D], [xs[2] + 3 * MM, yBot + D + tuck], [xs[3] - 3 * MM, yBot + D + tuck], [xs[3], yBot + D], [xs[3], yBot]]); // bottom lid + tuck
  for (const [a, b] of [[xs[1], xs[2]], [xs[3], xs[4]]]) {
    poly(cut, [[a, yTop], [a + 2 * MM, yTop - D * 0.6], [b - 2 * MM, yTop - D * 0.6], [b, yTop]]); // dust flaps
    poly(cut, [[a, yBot], [a + 2 * MM, yBot + D * 0.6], [b - 2 * MM, yBot + D * 0.6], [b, yBot]]);
  }
  line(cut, [xs[4], yTop], [xs[4], yBot]); // far edge

  writeFileSync(new URL(name, OUT), await pdf.save());
}

/** A wrap-around bottle label: green bleed, red trim (as on many printers' templates), artwork in three colour bands. */
async function label(name: string, sizeMm: { w: number; h: number }) {
  const W = sizeMm.w * MM, H = sizeMm.h * MM, bleed = 3 * MM, margin = 25 * MM;
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([W + margin * 2, H + margin * 2]);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const x = margin, y = margin; // bottom-left of the trim

  // Artwork runs into the bleed
  const third = (W + 2 * bleed) / 3;
  [LABEL_COLORS.left, LABEL_COLORS.middle, LABEL_COLORS.right].forEach((col, i) =>
    page.drawRectangle({ x: x - bleed + i * third, y: y - bleed, width: third, height: H + 2 * bleed, color: c(col) }),
  );
  page.drawRectangle({ x: x - bleed, y: y + H * 0.8, width: W + 2 * bleed, height: H * 0.2 + bleed, color: c(LABEL_COLORS.topStrip) });
  const size = H * 0.25;
  const text = "SAMPLE WATER";
  page.drawText(text, { x: x + (W - font.widthOfTextAtSize(text, size)) / 2, y: y + H * 0.35, size, font, color: rgb(1, 1, 1) });

  // Lines: bleed (green) outside, trim (red) on the cut
  page.drawRectangle({ x: x - bleed, y: y - bleed, width: W + 2 * bleed, height: H + 2 * bleed, borderColor: rgb(0.4, 0.75, 0.3), borderWidth: 1 });
  page.drawRectangle({ x, y, width: W, height: H, borderColor: rgb(0.9, 0.1, 0.12), borderWidth: 1 });

  writeFileSync(new URL(name, OUT), await pdf.save());
}

mkdirSync(OUT, { recursive: true });
const size = { w: 50, h: 120, d: 35 };
// Pacdora style: red folds, dark cuts
await carton("carton-red-folds.pdf", size, { color: rgb(0.97, 0.25, 0.2), width: 1 }, { color: rgb(0.2, 0.2, 0.4), width: 1 });
// Templatemaker style: thin cyan folds, thick crimson cuts (close to red!)
await carton("carton-cyan-folds.pdf", size, { color: rgb(0, 0.67, 0.93), width: 0.75 }, { color: rgb(0.83, 0.1, 0.35), width: 2 });
// Classic print style: everything black, folds dashed
await carton("carton-dashed-folds.pdf", size, { color: rgb(0, 0, 0), width: 0.5, dash: [4, 3] }, { color: rgb(0, 0, 0), width: 0.5 });
await label("bottle-label.pdf", { w: 200, h: 60 });
console.log("fixtures written");
