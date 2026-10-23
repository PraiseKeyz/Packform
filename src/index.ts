import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { buildBottleGlb, type BottleOptions } from "./bottle";
import { choosePages, detectDieline, type DetectOptions, type DielineLayout, type FaceName } from "./detect";
import { buildBoxGlb, type BoxSize } from "./glb";
import { openPdf, readPage, renderRegion, type PageInfo, type Rect } from "./pdf";

export { detectBox, detectLabel, detectDieline, choosePages, lineStyles } from "./detect";
export type { BoxLayout, LabelLayout, DielineLayout, DetectOptions, FaceLayout, FaceName, LineStyle, Rotation } from "./detect";
export { buildBoxGlb } from "./glb";
export type { BoxSize, BuildOptions, BuildResult } from "./glb";
export { buildBottleGlb } from "./bottle";
export type { BottleOptions } from "./bottle";
export { openPdf, readPage, renderRegion } from "./pdf";
export type { PageInfo, Rect, Segment } from "./pdf";

export interface DielineOptions extends DetectOptions {
  /** "carton" or "label". Default: worked out from the lines. */
  kind?: "carton" | "label";
  /**
   * Artwork to use instead of what is printed on the dieline: a PDF (first page) or an image (PNG, JPEG…)
   * laid out on the same artboard as the dieline. File path or bytes.
   */
  art?: string | Uint8Array;
  /** Texture resolution. Default 300. */
  dpi?: number;
  /** Cartons: override the box size in millimetres (otherwise measured from the dieline). */
  size?: BoxSize;
  /** Labels: bottle shape. Default: the label wraps once around a bottle 3 × as tall as it is wide. */
  bottle?: Omit<BottleOptions, "label" | "quality">;
  /** Page (0-based) holding the dieline lines. Default: automatic. */
  linesPage?: number;
  /** Page (0-based) holding the artwork. Default: a page with artwork and the fewest guide lines. */
  artPage?: number;
  /** JPEG quality of the texture (1-100). Default 90. */
  quality?: number;
}

export interface DielineResult {
  /** The 3D model as binary glTF. Write it to a `.glb` file. */
  glb: Uint8Array;
  /** The texture image (JPEG) baked into the model. */
  texture: Buffer;
  /** What was detected. `layout.kind` says whether it was a carton or a label. */
  layout: DielineLayout;
  /** Page (0-based) the artwork came from, or -1 when `art` was supplied. */
  artPage: number;
}

const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
const load = async (x: string | Uint8Array) => (typeof x === "string" ? new Uint8Array(await readFile(x)) : x);

type Cropper = (rect: Rect, dpi: number) => Promise<Buffer>;

/** Cut a region (in dieline page points) out of a separate artwork file laid out on the same artboard. */
async function artCropper(art: Uint8Array, page: PageInfo): Promise<{ crop: Cropper; close: () => Promise<void> }> {
  if (isPdf(art)) {
    const doc = await openPdf(art);
    const artPage = await doc.getPage(1);
    const [, , w, h] = artPage.view;
    const sx = w / page.width, sy = h / page.height;
    return {
      crop: (r, dpi) => renderRegion(artPage, [r[0] * sx, r[1] * sy, r[2] * sx, r[3] * sy], dpi),
      close: () => doc.destroy(),
    };
  }
  const meta = await sharp(art).metadata();
  const sx = meta.width! / page.width, sy = meta.height! / page.height;
  return {
    crop: async (r, dpi) => {
      const left = Math.max(0, Math.round(r[0] * sx)), top = Math.max(0, Math.round(r[1] * sy));
      const width = Math.min(meta.width! - left, Math.round((r[2] - r[0]) * sx));
      const height = Math.min(meta.height! - top, Math.round((r[3] - r[1]) * sy));
      const out = { w: Math.round(((r[2] - r[0]) * dpi) / 72), h: Math.round(((r[3] - r[1]) * dpi) / 72) };
      return sharp(art).extract({ left, top, width, height }).resize(out.w, out.h, { fit: "fill" }).png().toBuffer();
    },
    close: async () => {},
  };
}

/** Convert a dieline (.ai or .pdf: a file path or the file's bytes) into a 3D model: a box for cartons, a bottle for labels. */
export async function dielineToGlb(input: string | Uint8Array, options: DielineOptions = {}): Promise<DielineResult> {
  const doc = await openPdf(await load(input));
  const closers: (() => Promise<void>)[] = [() => doc.destroy()];
  try {
    const pages: PageInfo[] = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push(await readPage(await doc.getPage(i)));

    const auto = choosePages(pages);
    const linesPage = options.linesPage !== undefined ? pages[options.linesPage] : auto.lines;
    if (!linesPage) throw new Error(`Page ${options.linesPage! + 1} does not exist (the file has ${pages.length}).`);
    const layout = detectDieline(linesPage, options);
    const dpi = options.dpi ?? 300;

    let crop: Cropper;
    let artIndex = -1;
    if (options.art) {
      const c = await artCropper(await load(options.art), linesPage);
      closers.push(c.close);
      crop = c.crop;
    } else {
      artIndex = options.artPage ?? auto.art.index;
      const artPage = await doc.getPage(artIndex + 1);
      crop = (rect, d) => renderRegion(artPage, rect, d);
    }

    if (layout.kind === "label") {
      const image = await crop(layout.trim, dpi);
      const { glb, texture } = await buildBottleGlb(image, { ...options.bottle, label: layout.size, quality: options.quality });
      return { glb, texture, layout, artPage: artIndex };
    }

    const size = options.size ?? layout.size;
    const faces = {} as Record<FaceName, Buffer>;
    for (const [name, face] of Object.entries(layout.faces) as [FaceName, (typeof layout.faces)[FaceName]][]) {
      const png = await crop(face.rect, dpi);
      faces[name] = face.rotate ? await sharp(png).rotate(face.rotate).toBuffer() : png;
    }
    const { glb, atlas } = await buildBoxGlb(faces, size, { pxPerMm: dpi / 25.4, quality: options.quality });
    return { glb, texture: atlas, layout: { ...layout, size }, artPage: artIndex };
  } finally {
    for (const close of closers.reverse()) await close();
  }
}
