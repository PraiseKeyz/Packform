import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import type { FaceName } from "./detect";

export interface BoxSize {
  width: number;
  height: number;
  depth: number;
}

export interface BuildOptions {
  /** Atlas pixels per millimetre of box surface. Default 300 dpi ≈ 11.8 px/mm. */
  pxPerMm?: number;
  /** JPEG quality of the texture atlas (1-100). Default 90. */
  quality?: number;
}

export interface BuildResult {
  glb: Uint8Array;
  atlas: Buffer;
}

/**
 * Wrap six face images onto a box of the given size (millimetres) and return a binary glTF (.glb).
 *
 * Each image is the face as seen from outside the box, upright. For "top", the image's top edge
 * is the back of the box; for "bottom", the image's top edge is the front.
 */
export async function buildBoxGlb(faces: Record<FaceName, Buffer>, size: BoxSize, options: BuildOptions = {}): Promise<BuildResult> {
  const ppm = options.pxPerMm ?? 300 / 25.4;
  const { width: W, height: H, depth: D } = size;
  const px = (mm: number) => Math.max(1, Math.round(mm * ppm));
  const tw = px(W), th = px(H), sw = px(D), td = px(D);

  // Texture atlas: [front | right | back | left] on row 1, [top | bottom] on row 2
  const tiles: Record<FaceName, { x: number; y: number; w: number; h: number }> = {
    front: { x: 0, y: 0, w: tw, h: th },
    right: { x: tw, y: 0, w: sw, h: th },
    back: { x: tw + sw, y: 0, w: tw, h: th },
    left: { x: tw * 2 + sw, y: 0, w: sw, h: th },
    top: { x: 0, y: th, w: tw, h: td },
    bottom: { x: tw, y: th, w: tw, h: td },
  };
  const aw = tw * 2 + sw * 2, ah = th + td;
  const composites = await Promise.all(
    (Object.keys(tiles) as FaceName[]).map(async (name) => {
      const t = tiles[name];
      const input = await sharp(faces[name]).resize(t.w, t.h, { fit: "fill" }).toBuffer();
      return { input, left: t.x, top: t.y };
    }),
  );
  const atlas = await sharp({ create: { width: aw, height: ah, channels: 3, background: "#ffffff" } })
    .composite(composites)
    .jpeg({ quality: options.quality ?? 90 })
    .toBuffer();

  // glTF uses metres
  const w = W / 2000, h = H / 2000, d = D / 2000;
  // Corners in order bottom-left, bottom-right, top-right, top-left as seen from outside, plus the outward normal
  const quads: Record<FaceName, { corners: number[][]; normal: number[] }> = {
    front: { corners: [[-w, -h, d], [w, -h, d], [w, h, d], [-w, h, d]], normal: [0, 0, 1] },
    right: { corners: [[w, -h, d], [w, -h, -d], [w, h, -d], [w, h, d]], normal: [1, 0, 0] },
    back: { corners: [[w, -h, -d], [-w, -h, -d], [-w, h, -d], [w, h, -d]], normal: [0, 0, -1] },
    left: { corners: [[-w, -h, -d], [-w, -h, d], [-w, h, d], [-w, h, -d]], normal: [-1, 0, 0] },
    top: { corners: [[-w, h, d], [w, h, d], [w, h, -d], [-w, h, -d]], normal: [0, 1, 0] },
    bottom: { corners: [[-w, -h, -d], [w, -h, -d], [w, -h, d], [-w, -h, d]], normal: [0, -1, 0] },
  };
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  const e = 1; // inset UVs by a pixel so neighbouring tiles don't bleed at the edges
  for (const name of Object.keys(quads) as FaceName[]) {
    const { corners, normal } = quads[name];
    const t = tiles[name];
    // glTF UVs start at the top-left of the image
    const u0 = (t.x + e) / aw, u1 = (t.x + t.w - e) / aw;
    const v0 = (t.y + e) / ah, v1 = (t.y + t.h - e) / ah;
    const base = positions.length / 3;
    corners.forEach((c) => positions.push(...c));
    for (let i = 0; i < 4; i++) normals.push(...normal);
    uvs.push(u0, v1, u1, v1, u1, v0, u0, v0);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const doc = new Document();
  const buffer = doc.createBuffer();
  const texture = doc.createTexture("atlas").setImage(new Uint8Array(atlas)).setMimeType("image/jpeg");
  const material = doc
    .createMaterial("box")
    .setBaseColorTexture(texture)
    .setMetallicFactor(0)
    .setRoughnessFactor(0.55);
  const prim = doc
    .createPrimitive()
    .setMaterial(material)
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint16Array(indices)).setBuffer(buffer))
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer))
    .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(normals)).setBuffer(buffer))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(uvs)).setBuffer(buffer));
  const mesh = doc.createMesh("box").addPrimitive(prim);
  const node = doc.createNode("box").setMesh(mesh);
  doc.createScene("scene").addChild(node);

  const glb = await new NodeIO().writeBinary(doc);
  return { glb, atlas };
}
