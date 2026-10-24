import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { choosePages, detectDieline, type DetectOptions, type DielineLayout } from "./detect";
import { buildBlisterGlb, buildPillowGlb } from "./flat";
import { buildCartonGlb, type CartonGlbOptions } from "./fold";
import { openPdf, readPage, renderRegion, type PageInfo, type Rect } from "./pdf";
import { buildContainerGlb, buildCupGlb, type ContainerOptions } from "./shapes";

export { detectDieline, detectLabel, detectConeLabel, detectBlister, detectPillow, choosePages } from "./detect";
export type { DielineLayout, DielineKind, DetectOptions, LabelLayout, ConeLabelLayout } from "./detect";
export { detectCarton, buildCartonGlb, panelMatrices, panelPoint, panelNormal, foldAngleAt } from "./fold";
export type { CartonLayout, CartonOptions, CartonGlbOptions, FoldedPanel } from "./fold";
export { analyzePanels } from "./panels";
export type { Panel, Hinge, PanelAnalysis, Point } from "./panels";
export { buildContainerGlb, buildCupGlb, lathe } from "./shapes";
export type { ContainerShape, ContainerOptions, ConeLabel } from "./shapes";
export { buildBlisterGlb, buildPillowGlb } from "./flat";
export type { BlisterLayout, PillowLayout } from "./flat";
export { lineStyles, styleKey, describeStyle } from "./styles";
export type { LineStyle } from "./styles";
export { openPdf, readPage, renderRegion } from "./pdf";
export type { PageInfo, Rect, Segment } from "./pdf";

export interface DielineOptions extends DetectOptions {
  /**
   * Artwork to use instead of what is printed on the dieline: a PDF (first page) or an image (PNG, JPEG…)
   * laid out on the same artboard as the dieline. File path or bytes.
   */
  art?: string | Uint8Array;
  /** Texture resolution. Default 300 (lowered automatically so textures stay within 4096 px). */
  dpi?: number;
  /** Labels: container shape and size. Default: a water bottle the label wraps once around. */
  container?: Omit<ContainerOptions, "label" | "quality">;
  /** Cartons: board colour, and whether to include the fold animation. */
  carton?: CartonGlbOptions;
  /** Page (0-based) holding the dieline lines. Default: automatic. */
  linesPage?: number;
  /** Page (0-based) holding the artwork. Default: a page with artwork and the fewest guide lines. */
  artPage?: number;
  /** JPEG quality of textures (1-100). Default 90. */
  quality?: number;
}

export interface DielineResult {
  /** The 3D model as binary glTF. Write it to a `.glb` file. */
  glb: Uint8Array;
  /** The main texture image baked into the model. */
  texture: Buffer;
  /** What was detected. `layout.kind` says which kind of packaging it is. */
  layout: DielineLayout;
  /** Page (0-based) the artwork came from, or -1 when `art` was supplied. */
  artPage: number;
}

const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
const load = async (x: string | Uint8Array) => (typeof x === "string" ? new Uint8Array(await readFile(x)) : x);
const MAX_TEXTURE = 4096;

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
      const width = Math.max(1, Math.min(meta.width! - left, Math.round((r[2] - r[0]) * sx)));
      const height = Math.max(1, Math.min(meta.height! - top, Math.round((r[3] - r[1]) * sy)));
      const out = { w: Math.max(1, Math.round(((r[2] - r[0]) * dpi) / 72)), h: Math.max(1, Math.round(((r[3] - r[1]) * dpi) / 72)) };
      return sharp(art).extract({ left, top, width, height }).resize(out.w, out.h, { fit: "fill" }).png().toBuffer();
    },
    close: async () => {},
  };
}

/**
 * Convert a dieline (.ai or .pdf: a file path or the file's bytes) into a 3D model.
 * Cartons fold up (with a fold animation), labels wrap a container, cone labels wrap a cup,
 * and blister packs, sachets and pouches are built flat-and-puffed.
 */
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
    const wantDpi = options.dpi ?? 300;
    const q = options.quality;

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
    // Keep every texture within what browsers and phones can load
    const render = (r: Rect) => crop(r, Math.min(wantDpi, (MAX_TEXTURE * 72) / Math.max(r[2] - r[0], r[3] - r[1])));

    const done = (glb: Uint8Array, texture: Buffer): DielineResult => ({ glb, texture, layout, artPage: artIndex });
    switch (layout.kind) {
      case "carton": {
        const [x0, y0, x1, y1] = layout.bbox;
        const png = await render([x0, y0, x1, y1]);
        const texture = await sharp(png).jpeg({ quality: q ?? 90 }).toBuffer();
        return done(await buildCartonGlb(layout, texture, "image/jpeg", options.carton), texture);
      }
      case "label": {
        const r = await buildContainerGlb(await render(layout.trim), { ...options.container, label: layout.size, quality: q });
        return done(r.glb, r.texture);
      }
      case "cone-label": {
        const r = await buildCupGlb(await render(layout.bbox), layout, { quality: q });
        return done(r.glb, r.texture);
      }
      case "blister": {
        const r = await buildBlisterGlb(await render(layout.cardBox), layout, { quality: q });
        return done(r.glb, r.texture);
      }
      case "sachet":
      case "pouch": {
        const images = {
          front: await render(layout.front),
          back: layout.back ? await render(layout.back) : undefined,
          gusset: layout.gusset ? await render(layout.gusset) : undefined,
        };
        const r = await buildPillowGlb(images, layout, { quality: q });
        return done(r.glb, r.texture);
      }
    }
    throw new Error(`Unsupported dieline kind: ${(layout as { kind: string }).kind}`);
  } finally {
    for (const close of closers.reverse()) await close();
  }
}
export { initProject, buildProject, watchProject, detectFramework, loadConfig, modelName, artFor, CONFIG_FILE } from "./project";
export type { ProjectConfig, FileOptions, Framework, InitResult, BuildReport, Manifest, ManifestEntry, Watcher } from "./project";
