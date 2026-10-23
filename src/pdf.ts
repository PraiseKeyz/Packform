import { createRequire } from "node:module";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/display/api";

/** A rectangle in PDF points, top-left origin: [x0, y0, x1, y1]. */
export type Rect = [number, number, number, number];

/** A straight stroked line segment in PDF points, top-left origin. */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: [number, number, number];
  /** Stroke width in points. */
  width: number;
  dashed: boolean;
  /** Part of a flattened curve (arc, rounded corner) rather than a straight line in the file. */
  curved: boolean;
  /** Which drawn path this came from: segments with the same id were drawn together. */
  path: number;
}

export interface PageInfo {
  index: number;
  width: number;
  height: number;
  segments: Segment[];
  /** Number of image paints and filled paths: a rough "has artwork" signal. */
  artOps: number;
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

// pdf.js path codes inside constructPath data (DrawOPS in pdf.js)
const MOVE_TO = 0;
const LINE_TO = 1;
const CURVE_TO = 2;
const QUAD_TO = 3;
const CLOSE = 4;
const CURVE_STEPS = 8;

const STROKE_OPS = new Set<number>([
  OPS.stroke,
  OPS.closeStroke,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
]);
const FILL_OPS = new Set<number>([OPS.fill, OPS.eoFill]);

/** Apply B first, then A. */
function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function parseColor(arg: unknown): [number, number, number] {
  if (typeof arg === "string" && arg.startsWith("#")) {
    const n = parseInt(arg.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  if (Array.isArray(arg) || ArrayBuffer.isView(arg)) {
    const v = Array.from(arg as ArrayLike<number>);
    return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  }
  return [0, 0, 0];
}

const pdfjsDir = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({
    // pdf.js takes ownership of the buffer, so hand it a copy
    data: new Uint8Array(data),
    verbosity: 0,
    standardFontDataUrl: path.join(pdfjsDir, "standard_fonts") + path.sep,
    cMapUrl: path.join(pdfjsDir, "cmaps") + path.sep,
    cMapPacked: true,
  }).promise;
}

/** Collect every straight stroked segment on a page (with its style), plus a count of artwork operations. */
export async function readPage(page: PDFPageProxy): Promise<PageInfo> {
  const [, , width, height] = page.view;
  const { fnArray, argsArray } = await page.getOperatorList();

  type State = { ctm: Matrix; stroke: [number, number, number]; lineWidth: number; dashed: boolean };
  let state: State = { ctm: IDENTITY, stroke: [0, 0, 0], lineWidth: 1, dashed: false };
  const stack: State[] = [];
  const segments: Segment[] = [];
  let artOps = 0;
  let pathId = 0;

  // PDF space has y pointing up; flip so y grows downwards like an image
  const toTopLeft = (x: number, y: number): [number, number] => {
    const [px, py] = apply(state.ctm, x, y);
    return [px, height - py];
  };
  // Stroke widths are in user space; scale by the CTM to get points
  const scaleOf = (m: Matrix) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as any;
    switch (fn) {
      case OPS.save:
        stack.push(state);
        break;
      case OPS.restore:
        state = stack.pop() ?? state;
        break;
      case OPS.transform:
        state = { ...state, ctm: multiply(state.ctm, args as Matrix) };
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(state);
        if (args?.[0]) state = { ...state, ctm: multiply(state.ctm, Array.from(args[0]) as Matrix) };
        break;
      case OPS.paintFormXObjectEnd:
        state = stack.pop() ?? state;
        break;
      case OPS.setStrokeRGBColor:
        state = { ...state, stroke: parseColor(args[0] ?? args) };
        break;
      case OPS.setLineWidth:
        state = { ...state, lineWidth: Number(args[0]) || 0 };
        break;
      case OPS.setDash: {
        const dashes = args?.[0] as ArrayLike<number> | undefined;
        state = { ...state, dashed: !!dashes && Array.from(dashes).some((d) => d > 0) };
        break;
      }
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
        artOps++;
        break;
      case OPS.constructPath: {
        const [paintOp, [data]] = args as [number, [ArrayLike<number> | null]];
        if (FILL_OPS.has(paintOp)) artOps++;
        if (!STROKE_OPS.has(paintOp) || !data) break;
        const style = { color: state.stroke, width: state.lineWidth * scaleOf(state.ctm), dashed: state.dashed, path: pathId++ };
        let cur: [number, number] = [0, 0];
        let start: [number, number] = [0, 0];
        const add = (a: [number, number], b: [number, number], curved = false) => {
          const [x1, y1] = toTopLeft(...a);
          const [x2, y2] = toTopLeft(...b);
          segments.push({ x1, y1, x2, y2, ...style, curved });
        };
        // Curves become short straight pieces so round shapes (tucks, circles, arcs) can be measured
        const addCurve = (pts: [number, number][]) => {
          const n = CURVE_STEPS;
          let prev = pts[0];
          for (let k = 1; k <= n; k++) {
            const t = k / n, u = 1 - t;
            const p: [number, number] =
              pts.length === 4
                ? [
                    u * u * u * pts[0][0] + 3 * u * u * t * pts[1][0] + 3 * u * t * t * pts[2][0] + t * t * t * pts[3][0],
                    u * u * u * pts[0][1] + 3 * u * u * t * pts[1][1] + 3 * u * t * t * pts[2][1] + t * t * t * pts[3][1],
                  ]
                : [
                    u * u * pts[0][0] + 2 * u * t * pts[1][0] + t * t * pts[2][0],
                    u * u * pts[0][1] + 2 * u * t * pts[1][1] + t * t * pts[2][1],
                  ];
            add(prev, p, true);
            prev = p;
          }
        };
        for (let j = 0; j < data.length; ) {
          const op = data[j++];
          if (op === MOVE_TO) {
            cur = start = [data[j], data[j + 1]];
            j += 2;
          } else if (op === LINE_TO) {
            const next: [number, number] = [data[j], data[j + 1]];
            add(cur, next);
            cur = next;
            j += 2;
          } else if (op === CURVE_TO) {
            const end: [number, number] = [data[j + 4], data[j + 5]];
            addCurve([cur, [data[j], data[j + 1]], [data[j + 2], data[j + 3]], end]);
            cur = end;
            j += 6;
          } else if (op === QUAD_TO) {
            const end: [number, number] = [data[j + 2], data[j + 3]];
            addCurve([cur, [data[j], data[j + 1]], end]);
            cur = end;
            j += 4;
          } else if (op === CLOSE) {
            add(cur, start);
            cur = start;
          } else {
            break; // unknown code: stop reading this path rather than misread it
          }
        }
        break;
      }
    }
  }
  return { index: page.pageNumber - 1, width, height, segments, artOps };
}

/** Render a region of a page to a PNG at the given resolution. */
export async function renderRegion(page: PDFPageProxy, rect: Rect, dpi: number): Promise<Buffer> {
  const scale = dpi / 72;
  const [x0, y0, x1, y1] = rect;
  const viewport = page.getViewport({ scale, offsetX: -x0 * scale, offsetY: -y0 * scale });
  const canvas = createCanvas(Math.max(1, Math.round((x1 - x0) * scale)), Math.max(1, Math.round((y1 - y0) * scale)));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx as any, canvas: canvas as any, viewport }).promise;
  return canvas.toBuffer("image/png");
}
