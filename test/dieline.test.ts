import { existsSync } from "node:fs";
import { NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { dielineToGlb, type BoxLayout, type LabelLayout } from "../src/index";
import { FACE_COLORS, LABEL_COLORS } from "./colors";

const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const DPI = 72;
const px = (mm: number) => Math.max(1, Math.round((mm * DPI) / 25.4));

/** Average colour of a small square of the texture. */
async function colorAt(image: Buffer, x: number, y: number): Promise<number[]> {
  const { data } = await sharp(image).extract({ left: Math.round(x) - 2, top: Math.round(y) - 2, width: 4, height: 4 }).raw().toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += 3) for (let k = 0; k < 3; k++) sum[k] += data[i + k];
  return sum.map((v) => v / (data.length / 3));
}
const expectColor = (actual: number[], expected: readonly number[]) =>
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]), `channel ${i}: got ${actual.map(Math.round)} want ${expected}`).toBeLessThan(30));

describe.each([
  ["Pacdora style: red folds, dark cuts", "carton-red-folds.pdf", false],
  ["Templatemaker style: cyan folds, crimson cuts", "carton-cyan-folds.pdf", false],
  ["print style: black dashed folds, black solid cuts", "carton-dashed-folds.pdf", true],
])("carton, %s", async (_name, file, dashed) => {
  const result = await dielineToGlb(fixture(file), { dpi: DPI });
  const layout = result.layout as BoxLayout;

  it("is detected as a carton at its true size", () => {
    expect(layout.kind).toBe("carton");
    expect(layout.size).toEqual({ width: 50, height: 120, depth: 35 });
  });

  it("recognises the fold lines by shape, whatever their colour", () => {
    expect(layout.foldStyle.dashed).toBe(dashed);
  });

  it("puts every wall on the right face", async () => {
    // Atlas: [front | right | back | left] on row 1, [top | bottom] on row 2
    const [tw, sw, th] = [px(50), px(35), px(120)];
    const mid = th * 0.25; // above the face label text
    expectColor(await colorAt(result.texture, tw / 2, mid), FACE_COLORS.front);
    expectColor(await colorAt(result.texture, tw + sw / 2, mid), FACE_COLORS.right);
    expectColor(await colorAt(result.texture, tw + sw + tw / 2, mid), FACE_COLORS.back);
    expectColor(await colorAt(result.texture, 2 * tw + sw + sw / 2, mid), FACE_COLORS.left);
  });

  it("turns the lids so they sit correctly once folded", async () => {
    const [tw, th, td] = [px(50), px(120), px(35)];
    // Top tile: image top = back edge = the lid's hinge
    expectColor(await colorAt(result.texture, tw / 2, th + td * 0.25), FACE_COLORS.topHinge);
    expectColor(await colorAt(result.texture, tw / 2, th + td * 0.75), FACE_COLORS.topFar);
    // Bottom tile: image top = front edge = the lid's hinge
    expectColor(await colorAt(result.texture, tw + tw / 2, th + td * 0.25), FACE_COLORS.bottomHinge);
    expectColor(await colorAt(result.texture, tw + tw / 2, th + td * 0.75), FACE_COLORS.bottomFar);
  });

  it("writes a valid glb box in metres", async () => {
    const doc = await new NodeIO().readBinary(result.glb);
    const pos = doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute("POSITION")!;
    expect(pos.getCount()).toBe(24);
    const [min, max] = [pos.getMinNormalized([]), pos.getMaxNormalized([])];
    expect(max[0] - min[0]).toBeCloseTo(0.05);
    expect(max[1] - min[1]).toBeCloseTo(0.12);
    expect(max[2] - min[2]).toBeCloseTo(0.035);
  });
});

describe("bottle label", async () => {
  const result = await dielineToGlb(fixture("bottle-label.pdf"), { dpi: DPI });
  const layout = result.layout as LabelLayout;

  it("finds the trim inside the bleed", () => {
    expect(layout.kind).toBe("label");
    expect(layout.size).toEqual({ width: 200, height: 60 });
    expect(layout.bleed).toBeDefined();
  });

  it("uses the trimmed artwork as the label texture, the right way round", async () => {
    const { width = 0, height = 0 } = await sharp(result.texture).metadata();
    expect(width / height).toBeCloseTo(200 / 60, 1);
    expectColor(await colorAt(result.texture, width * 0.1, height * 0.6), LABEL_COLORS.left);
    expectColor(await colorAt(result.texture, width * 0.9, height * 0.6), LABEL_COLORS.right);
    expectColor(await colorAt(result.texture, width * 0.1, height * 0.05), LABEL_COLORS.topStrip);
  });

  it("builds a bottle the label wraps around once", async () => {
    const doc = await new NodeIO().readBinary(result.glb);
    const meshes = doc.getRoot().listMeshes().map((m) => m.getName());
    expect(meshes.sort()).toEqual(["body", "cap", "label"]);
    const body = doc.getRoot().listMeshes().find((m) => m.getName() === "body")!.listPrimitives()[0].getAttribute("POSITION")!;
    const [min, max] = [body.getMinNormalized([]), body.getMaxNormalized([])];
    expect((max[0] - min[0]) * 1000).toBeCloseTo(200 / Math.PI, 0); // diameter = label width ÷ π
  });

  it("respects a custom diameter and height", async () => {
    const r = await dielineToGlb(fixture("bottle-label.pdf"), { dpi: 36, bottle: { diameter: 80, height: 250 } });
    const doc = await new NodeIO().readBinary(r.glb);
    const pos = doc.getRoot().listMeshes().find((m) => m.getName() === "body")!.listPrimitives()[0].getAttribute("POSITION")!;
    const [min, max] = [pos.getMinNormalized([]), pos.getMaxNormalized([])];
    expect((max[0] - min[0]) * 1000).toBeCloseTo(80, 0);
    const cap = doc.getRoot().listMeshes().find((m) => m.getName() === "cap")!.listPrimitives()[0].getAttribute("POSITION")!;
    expect((cap.getMaxNormalized([])[1] - min[1]) * 1000).toBeCloseTo(250, 0);
  });
});

// Real-world templates downloaded into samples/ (not committed: their licences don't allow sharing)
const sample = (name: string) => new URL(`../samples/${name}`, import.meta.url).pathname;
describe.skipIf(!existsSync(sample("templatemaker-cardbox-50x50x120.pdf")))("sample: Templatemaker card box", () => {
  it("is a 50 × 120 × 50 mm carton with cyan folds", async () => {
    const { layout } = await dielineToGlb(sample("templatemaker-cardbox-50x50x120.pdf"), { dpi: 36 });
    expect(layout.kind).toBe("carton");
    expect(layout.size).toEqual({ width: 50, height: 120, depth: 50 });
  });
});
describe.skipIf(!existsSync(sample("bottle-label-12oz-2x7.pdf")))("sample: CustomWater 12 oz bottle label", () => {
  it("is a 7 × 2 inch label (red = cut, green = bleed)", async () => {
    const { layout } = await dielineToGlb(sample("bottle-label-12oz-2x7.pdf"), { dpi: 36 });
    expect(layout.kind).toBe("label");
    expect(layout.size).toEqual({ width: 178, height: 51 });
  });
});
