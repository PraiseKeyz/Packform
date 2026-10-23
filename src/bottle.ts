import { Document, NodeIO, type Material } from "@gltf-transform/core";
import sharp from "sharp";

export interface BottleOptions {
  /** Label size in mm (the trimmed label). */
  label: { width: number; height: number };
  /** Bottle diameter in mm. Default: the label wraps exactly once around (width ÷ π). */
  diameter?: number;
  /** Total bottle height in mm, cap included. Default: 3 × diameter (taller if the label needs it). */
  height?: number;
  /** Cap colour as #rrggbb. Default a blue cap. */
  capColor?: string;
  /** Bottle body colour as #rrggbb. Default a faint blue-tinted clear plastic. */
  bodyColor?: string;
  /** Body opacity 0-1. Default 0.45 (see-through PET). Use 1 for an opaque bottle. */
  bodyOpacity?: number;
  /** JPEG quality of the label texture. Default 90. */
  quality?: number;
}

type Profile = [radius: number, y: number][];

const SEGMENTS = 96;

/** Spin a profile (radius, height) around the Y axis. θ = 0 faces +Z (the front). */
function lathe(profile: Profile, thetaStart = -Math.PI, thetaLength = Math.PI * 2, segments = SEGMENTS) {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  // Smooth normals from the profile's tangent: outward = (dy, -dr) in (radial, y)
  const profNormals = profile.map((_, i) => {
    const a = profile[Math.max(0, i - 1)], b = profile[Math.min(profile.length - 1, i + 1)];
    const dr = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dr, dy) || 1;
    return [dy / l, -dr / l];
  });
  for (let i = 0; i < profile.length; i++) {
    const [r, y] = profile[i];
    const [nr, ny] = profNormals[i];
    for (let j = 0; j <= segments; j++) {
      const t = thetaStart + (j / segments) * thetaLength;
      const s = Math.sin(t), c = Math.cos(t);
      positions.push(r * s, y, r * c);
      normals.push(nr * s, ny, nr * c);
      // glTF UVs start at the top-left of the image
      uvs.push(j / segments, 1 - i / (profile.length - 1));
    }
  }
  const row = segments + 1;
  for (let i = 0; i < profile.length - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * row + j, b = a + 1, c = a + row + 1, d = a + row;
      indices.push(a, b, c, a, c, d);
    }
  }
  return { positions, normals, uvs, indices };
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  // glTF base colours are linear; convert from sRGB
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.pow(v / 255, 2.2)) as [number, number, number];
}

/**
 * Build a bottle (body, shoulder, neck, cap) with the label image wrapped around the body, as binary glTF.
 * The label's horizontal centre faces the front (+Z).
 */
export async function buildBottleGlb(labelImage: Buffer, options: BottleOptions): Promise<{ glb: Uint8Array; texture: Buffer }> {
  const { label } = options;
  const D = options.diameter ?? label.width / Math.PI;
  const r = D / 2;
  // The straight part of the body runs from 0.1 r to 68% of the height; make sure the label fits on it
  const minHeight = (label.height + r * 0.3) / 0.6;
  const H = Math.max(options.height ?? D * 3, minHeight);

  const yShoulder = H * 0.68;
  const neckR = r * 0.36;
  const yNeck = H * 0.86;
  const yNeckTop = H * 0.9;
  const capR = neckR * 1.15;
  const yCap = H * 0.875;

  const body: Profile = [[0, 0], [r * 0.9, 0], [r * 0.98, r * 0.03], [r, r * 0.1], [r, yShoulder]];
  const steps = 14;
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const ease = (1 - Math.cos(Math.PI * t)) / 2; // smooth S-curve from the body down to the neck
    body.push([r + (neckR - r) * ease, yShoulder + (yNeck - yShoulder) * t]);
  }
  body.push([neckR, yNeckTop]);

  const cap: Profile = [[0, yCap], [capR, yCap], [capR, H - capR * 0.12], [capR * 0.92, H], [0, H]];

  // Label band: a slice of cylinder just outside the body
  const lr = r * 1.004;
  const arc = Math.min(Math.PI * 2, label.width / r);
  const yMid = (r * 0.1 + yShoulder) / 2;
  const band: Profile = [];
  const bandRows = 2;
  for (let k = 0; k <= bandRows; k++) band.push([lr, yMid - label.height / 2 + (label.height * k) / bandRows]);

  const toM = 1 / 1000; // glTF uses metres; centre the bottle vertically
  const shift = (p: Profile): Profile => p.map(([pr, py]) => [pr * toM, (py - H / 2) * toM]);

  const texture = await sharp(labelImage).jpeg({ quality: options.quality ?? 90 }).toBuffer();

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("scene");
  const addMesh = (name: string, geo: ReturnType<typeof lathe>, material: Material) => {
    const prim = doc
      .createPrimitive()
      .setMaterial(material)
      .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(geo.indices)).setBuffer(buffer))
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(geo.positions)).setBuffer(buffer))
      .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(geo.normals)).setBuffer(buffer))
      .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(geo.uvs)).setBuffer(buffer));
    scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
  };

  const opacity = options.bodyOpacity ?? 0.45;
  const bodyMat = doc
    .createMaterial("body")
    .setBaseColorFactor([...hexToRgb(options.bodyColor ?? "#dcecf5"), opacity])
    .setAlphaMode(opacity < 1 ? "BLEND" : "OPAQUE")
    .setMetallicFactor(0)
    .setRoughnessFactor(0.12);
  const capMat = doc
    .createMaterial("cap")
    .setBaseColorFactor([...hexToRgb(options.capColor ?? "#1f5fbf"), 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.45);
  const labelTex = doc.createTexture("label").setImage(new Uint8Array(texture)).setMimeType("image/jpeg");
  const labelMat = doc
    .createMaterial("label")
    .setBaseColorTexture(labelTex)
    .setMetallicFactor(0)
    .setRoughnessFactor(0.5)
    .setDoubleSided(arc < Math.PI * 2); // the back of a part-wrap label shows through clear plastic

  // Label first so it draws before the see-through body
  addMesh("label", lathe(shift(band), -arc / 2, arc), labelMat);
  addMesh("cap", lathe(shift(cap)), capMat);
  addMesh("body", lathe(shift(body)), bodyMat);

  const glb = await new NodeIO().writeBinary(doc);
  return { glb, texture };
}
