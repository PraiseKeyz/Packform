import { existsSync } from "node:fs";
import { NodeIO, type Document } from "@gltf-transform/core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { dielineToGlb, panelMatrices, panelNormal, panelPoint, type CartonLayout, type DielineResult, type Point } from "../src/index";
import { FACE_COLORS, FIXTURE_SIZES as S, FLAT_COLORS, LABEL_COLORS } from "./colors";

const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const DPI = 72;
const io = new NodeIO();

/** Average colour of a small square of an image, at fractional position (u, v). */
async function colorAt(image: Buffer, u: number, v: number): Promise<number[]> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  const x = Math.min(width - 4, Math.max(0, Math.round(u * width) - 2)), y = Math.min(height - 4, Math.max(0, Math.round(v * height) - 2));
  const { data, info } = await sharp(image).extract({ left: x, top: y, width: 4, height: 4 }).raw().toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += info.channels) for (let k = 0; k < 3; k++) sum[k] += data[i + k];
  return sum.map((s) => s / (data.length / info.channels));
}
const expectColor = (actual: number[], expected: readonly number[], tol = 32) =>
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]), `got ${actual.map(Math.round)} want ${expected}`).toBeLessThan(tol));

/** Colour of the carton artwork at a page point. */
const cartonColor = (r: DielineResult, layout: CartonLayout, pt: Point) => {
  const [x0, y0, x1, y1] = layout.bbox;
  return colorAt(r.texture, (pt[0] - x0) / (x1 - x0), (pt[1] - y0) / (y1 - y0));
};

/** The biggest panel whose printed side faces a direction once folded. */
function facing(layout: CartonLayout, dir: [number, number, number]) {
  const m = panelMatrices(layout);
  const hits = layout.panels.filter((p) => {
    const n = panelNormal(m, p.id);
    return n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] > 0.95;
  });
  return hits.sort((a, b) => b.area - a.area)[0];
}

const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const sizeClose = (actual: Record<string, number>, expected: Record<string, number>, tol = 1.5) => {
  for (const k of Object.keys(expected)) expect(Math.abs(actual[k] - expected[k]), `${k}: ${actual[k]} vs ${expected[k]}`).toBeLessThanOrEqual(tol);
};
const meshNames = (doc: Document) => doc.getRoot().listMeshes().map((m) => m.getName());

describe.each([
  ["red folds, dark cuts", "carton-red-folds.pdf", false],
  ["thin cyan folds, thick crimson cuts", "carton-cyan-folds.pdf", false],
  ["black dashed folds, black solid cuts", "carton-dashed-folds.pdf", true],
])("tuck-end carton, %s", async (_name, file, dashed) => {
  const result = await dielineToGlb(fixture(file), { dpi: DPI });
  const layout = result.layout as CartonLayout;

  it("is found as a carton, at its true size, whatever the line colours", () => {
    expect(layout.kind).toBe("carton");
    expect(layout.foldStyle.dashed).toBe(dashed);
    expect(layout.panels).toHaveLength(13);
    expect(layout.orientation).toBe("standing");
    sizeClose(layout.size, { width: S.tuckEnd.w, height: S.tuckEnd.h, depth: S.tuckEnd.d });
  });

  it("folds every wall to the right side", async () => {
    for (const [dir, color] of [
      [[0, 0, 1], FACE_COLORS.front],
      [[0, 0, -1], FACE_COLORS.back],
      [[1, 0, 0], FACE_COLORS.right],
      [[-1, 0, 0], FACE_COLORS.left],
    ] as const) {
      const p = facing(layout, dir as [number, number, number]);
      // sample a quarter of the way down, clear of the face's text
      const pt: Point = [p.centroid[0], p.bbox[1] + (p.bbox[3] - p.bbox[1]) * 0.2];
      expectColor(await cartonColor(result, layout, pt), color);
    }
  });

  it("closes the top lid with its hinge at the back and the bottom lid with its hinge at the front", async () => {
    const m = panelMatrices(layout);
    for (const [dir, hingeColor, farColor, hingeAtBack] of [
      [[0, 1, 0], FACE_COLORS.topHinge, FACE_COLORS.topFar, true],
      [[0, -1, 0], FACE_COLORS.bottomHinge, FACE_COLORS.bottomFar, false],
    ] as const) {
      const lid = facing(layout, dir as [number, number, number]);
      const mid = lerp(lid.hinge!.p1, lid.hinge!.p2, 0.5);
      const nearHinge = lerp(mid, lid.centroid, 0.5), farSide = lerp(mid, lid.centroid, 1.5);
      expectColor(await cartonColor(result, layout, nearHinge), hingeColor);
      expectColor(await cartonColor(result, layout, farSide), farColor);
      const z = panelPoint(layout, m, lid.id, mid)[2];
      expect(hingeAtBack ? z < 0 : z > 0).toBe(true);
    }
  });

  it("ships a fold animation, one channel per folding panel", async () => {
    const doc = await io.readBinary(result.glb);
    const anim = doc.getRoot().listAnimations()[0];
    expect(anim.getName()).toBe("fold");
    expect(anim.listChannels()).toHaveLength(12);
    expect(layout.duration).toBe(4);
    // walls fold first (the first quarter of the animation); an eighth of the way in they are half folded
    const wall = layout.panels.find((p) => p.parent === 0 && p.stage === 0)!;
    expect(panelNormal(panelMatrices(layout, 0.125), wall.id)[2]).toBeCloseTo(Math.cos(Math.PI / 4), 2);
    // and the lids only start once the walls are done: still in line with the wall they hang from
    const lid = facing(layout, [0, 1, 0]);
    const quarter = panelMatrices(layout, 0.25);
    const [a, b] = [panelNormal(quarter, lid.id), panelNormal(quarter, lid.parent)];
    expect(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).toBeGreaterThan(0.99);
  });

  it("lies flat at the start of the animation", () => {
    const flat = panelMatrices(layout, 0);
    for (const p of layout.panels) expect(panelNormal(flat, p.id)[2]).toBeCloseTo(1, 3);
  });
});

describe("other carton styles", () => {
  it("tray: a base with walls and corner flaps, standing on its base", async () => {
    const { layout } = await dielineToGlb(fixture("tray.pdf"), { dpi: 36 });
    const l = layout as CartonLayout;
    expect(l.kind).toBe("carton");
    expect(l.orientation).toBe("base-down");
    expect(l.panels).toHaveLength(9);
    sizeClose(l.size, { width: S.tray.l, height: S.tray.h, depth: S.tray.w });
    expect(panelNormal(panelMatrices(l), l.root)[1]).toBeCloseTo(-1, 3); // base faces the floor
  });

  it("mailer box: double front wall, lid with tuck and side flaps, lying flat", async () => {
    const { layout } = await dielineToGlb(fixture("mailer.pdf"), { dpi: 36 });
    const l = layout as CartonLayout;
    expect(l.kind).toBe("carton");
    expect(l.orientation).toBe("base-down");
    expect(l.panels).toHaveLength(11);
    sizeClose(l.size, { width: S.mailer.w, height: S.mailer.h, depth: S.mailer.l });
    // the lid closes on top
    const lid = facing(l, [0, 1, 0]);
    expect(lid.area).toBeCloseTo(l.panels[l.root].area, -2);
  });

  it("sleeve: four walls and a glue flap, open at both ends", async () => {
    const { layout } = await dielineToGlb(fixture("sleeve.pdf"), { dpi: 36 });
    const l = layout as CartonLayout;
    expect(l.panels).toHaveLength(5);
    expect(l.orientation).toBe("standing");
    sizeClose(l.size, { width: S.sleeve.w, height: S.sleeve.h, depth: S.sleeve.d });
    expect(facing(l, [0, 1, 0])).toBeUndefined();
  });

  it("crash-lock bottom: the diagonal glue folds don't split the bottom flaps", async () => {
    const { layout } = await dielineToGlb(fixture("crash-lock.pdf"), { dpi: 36 });
    const l = layout as CartonLayout;
    expect(l.panels).toHaveLength(13);
    sizeClose(l.size, { width: S.crashLock.w, height: S.crashLock.h, depth: S.crashLock.d });
    const bottoms = l.panels.filter((p) => panelNormal(panelMatrices(l), p.id)[1] < -0.95);
    expect(bottoms).toHaveLength(4);
  });

  it("can fold to other angles", async () => {
    const { layout } = await dielineToGlb(fixture("sleeve.pdf"), { dpi: 36, foldAngle: 45 });
    const l = layout as CartonLayout;
    expect(panelNormal(panelMatrices(l), l.panels[1].id)[0]).toBeCloseTo(Math.sin(Math.PI / 4) * Math.sign(panelNormal(panelMatrices(l), l.panels[1].id)[0]), 3);
  });
});

describe("wrap-around label", async () => {
  const result = await dielineToGlb(fixture("bottle-label.pdf"), { dpi: DPI });

  it("finds the trim inside the bleed", () => {
    expect(result.layout.kind).toBe("label");
    if (result.layout.kind !== "label") return;
    expect(result.layout.size).toEqual({ width: S.label.w, height: S.label.h });
    expect(result.layout.bleed).toBeDefined();
  });

  it("uses the trimmed artwork, the right way round", async () => {
    expectColor(await colorAt(result.texture, 0.1, 0.6), LABEL_COLORS.left);
    expectColor(await colorAt(result.texture, 0.9, 0.6), LABEL_COLORS.right);
    expectColor(await colorAt(result.texture, 0.1, 0.05), LABEL_COLORS.topStrip);
  });

  it.each(["bottle", "amber", "jar", "can", "tube"] as const)("wraps a %s", async (shape) => {
    const r = await dielineToGlb(fixture("bottle-label.pdf"), { dpi: 36, container: { shape } });
    const doc = await io.readBinary(r.glb);
    expect(meshNames(doc)).toContain("label");
    expect(meshNames(doc)).toContain("body");
    const body = doc.getRoot().listMeshes().find((m) => m.getName() === "body")!.listPrimitives()[0].getAttribute("POSITION")!;
    const [min, max] = [body.getMinNormalized([]), body.getMaxNormalized([])];
    if (shape !== "tube") expect((max[2] - min[2]) * 1000).toBeCloseTo(S.label.w / Math.PI, 0); // label wraps once
  });

  it("respects a custom diameter and height", async () => {
    const r = await dielineToGlb(fixture("bottle-label.pdf"), { dpi: 36, container: { diameter: 80, height: 250 } });
    const doc = await io.readBinary(r.glb);
    const all = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives().map((p) => p.getAttribute("POSITION")!));
    const minY = Math.min(...all.map((a) => a.getMinNormalized([])[1])), maxY = Math.max(...all.map((a) => a.getMaxNormalized([])[1]));
    expect((maxY - minY) * 1000).toBeCloseTo(250, 0);
  });
});

describe("cone label → cup", async () => {
  const result = await dielineToGlb(fixture("cup-label.pdf"), { dpi: DPI });

  it("finds the curved trim, not the bleed", () => {
    expect(result.layout.kind).toBe("cone-label");
    if (result.layout.kind !== "cone-label") return;
    expect(result.layout.size.outer).toBeCloseTo(Math.PI * S.cup.top, -0.5);
    expect(result.layout.size.inner).toBeCloseTo(Math.PI * S.cup.bottom, -0.5);
  });

  it("builds a cup with the wide end up and the label at the right diameters", async () => {
    const doc = await io.readBinary(result.glb);
    const label = doc.getRoot().listMeshes().find((m) => m.getName() === "label")!.listPrimitives()[0].getAttribute("POSITION")!;
    const v = [0, 0, 0];
    let top = { y: -Infinity, r: 0 }, bottom = { y: Infinity, r: 0 };
    for (let i = 0; i < label.getCount(); i++) {
      label.getElement(i, v);
      const r = Math.hypot(v[0], v[2]);
      if (v[1] > top.y) top = { y: v[1], r };
      if (v[1] < bottom.y) bottom = { y: v[1], r };
    }
    expect(top.r * 2000).toBeCloseTo(S.cup.top, -0.5);
    expect(bottom.r * 2000).toBeCloseTo(S.cup.bottom, -0.5);
    expect((top.y - bottom.y) * 1000).toBeCloseTo(S.cup.height, -0.5);
  });

  it("finds the trim when the bleed is drawn in the same style as the cut", async () => {
    const { layout } = await dielineToGlb(fixture("cup-label-one-style.pdf"), { dpi: 36 });
    expect(layout.kind).toBe("cone-label");
    if (layout.kind !== "cone-label") return;
    expect(layout.size.outer).toBeCloseTo(Math.PI * S.cup.top, -0.5);
    expect(layout.size.inner).toBeCloseTo(Math.PI * S.cup.bottom, -0.5);
    expect(layout.size.height).toBeCloseTo(Math.hypot(S.cup.height, (S.cup.top - S.cup.bottom) / 2), -0.5); // slant height
  });
});

describe("blister pack", async () => {
  const result = await dielineToGlb(fixture("blister.pdf"), { dpi: DPI });

  it("finds the card and every cavity", () => {
    expect(result.layout.kind).toBe("blister");
    if (result.layout.kind !== "blister") return;
    expect(result.layout.cavities).toHaveLength(S.blister.rows * S.blister.cols);
    sizeClose(result.layout.size, { width: S.blister.w, height: S.blister.h });
  });

  it("builds the card with a dome and a tablet over each cavity", async () => {
    const doc = await io.readBinary(result.glb);
    expect(meshNames(doc).filter((n) => n.startsWith("cavity"))).toHaveLength(10);
    expectColor(await colorAt(result.texture, 0.02, 0.5), FLAT_COLORS.blister);
  });
});

describe("sachet and pouch", () => {
  it("sachet: front and back side by side", async () => {
    const r = await dielineToGlb(fixture("sachet.pdf"), { dpi: DPI });
    expect(r.layout.kind).toBe("sachet");
    if (r.layout.kind !== "sachet") return;
    expect(r.layout.back).toBeDefined();
    expect(r.layout.size).toEqual({ width: S.sachet.w, height: S.sachet.h });
    expectColor(await colorAt(r.texture, 0.1, 0.1), FLAT_COLORS.sachetFront);
  });

  it("pouch: front and back with a bottom gusset", async () => {
    const r = await dielineToGlb(fixture("pouch.pdf"), { dpi: 36 });
    expect(r.layout.kind).toBe("pouch");
    if (r.layout.kind !== "pouch") return;
    expect(r.layout.gusset).toBeDefined();
    const doc = await io.readBinary(r.glb);
    expect(meshNames(doc)).toEqual(["pouch", "gusset"]);
  });

  it("a single panel can be forced to be a sachet", async () => {
    const r = await dielineToGlb(fixture("bottle-label.pdf"), { dpi: 36, kind: "sachet" });
    expect(r.layout.kind).toBe("sachet");
  });
});

// Real-world templates downloaded into samples/ (not committed: their licences don't allow sharing)
const sample = (name: string) => new URL(`../samples/${name}`, import.meta.url).pathname;
describe.skipIf(!existsSync(sample("cardbox-50x50x120.pdf")))("sample: downloaded card box template", () => {
  it("folds into a 50 × 120 × 50 mm carton", async () => {
    const { layout } = await dielineToGlb(sample("cardbox-50x50x120.pdf"), { dpi: 36 });
    expect(layout.kind).toBe("carton");
    sizeClose((layout as CartonLayout).size, { width: 50, height: 120, depth: 50 }, 2);
  });
});
describe.skipIf(!existsSync(sample("bottle-label-12oz.pdf")))("sample: downloaded 12 oz bottle label template", () => {
  it("is a 7 × 2 inch label (red = cut, green = bleed)", async () => {
    const { layout } = await dielineToGlb(sample("bottle-label-12oz.pdf"), { dpi: 36 });
    expect(layout.kind).toBe("label");
    expect((layout as { size: object }).size).toEqual({ width: 178, height: 51 });
  });
});
