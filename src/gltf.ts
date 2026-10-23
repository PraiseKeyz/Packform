import { Document, NodeIO, type Material, type Node } from "@gltf-transform/core";

export interface Geometry {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

export interface MaterialSpec {
  /** #rrggbb (sRGB). */
  color?: string;
  opacity?: number;
  metallic?: number;
  roughness?: number;
  texture?: { image: Buffer; mimeType: "image/jpeg" | "image/png" };
  doubleSided?: boolean;
}

const toLinear = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.pow(v / 255, 2.2)) as [number, number, number];
};

/** Small wrapper around glTF-Transform for building a single-scene model. */
export class GlbBuilder {
  readonly doc = new Document();
  private buffer = this.doc.createBuffer();
  readonly root: Node;

  constructor(name = "packform") {
    this.root = this.doc.createNode(name);
    this.doc.createScene("scene").addChild(this.root);
  }

  material(name: string, spec: MaterialSpec): Material {
    const opacity = spec.opacity ?? 1;
    const m = this.doc
      .createMaterial(name)
      .setBaseColorFactor([...toLinear(spec.color ?? "#ffffff"), opacity])
      .setMetallicFactor(spec.metallic ?? 0)
      .setRoughnessFactor(spec.roughness ?? 0.5)
      .setDoubleSided(spec.doubleSided ?? false);
    if (opacity < 1) m.setAlphaMode("BLEND");
    if (spec.texture) m.setBaseColorTexture(this.doc.createTexture(name).setImage(new Uint8Array(spec.texture.image)).setMimeType(spec.texture.mimeType));
    return m;
  }

  /** Add a mesh as a child of `parent` (default: the model root). */
  mesh(name: string, parts: { geometry: Geometry; material: Material }[], parent: Node = this.root): Node {
    const mesh = this.doc.createMesh(name);
    for (const { geometry: g, material } of parts) {
      const acc = (type: "SCALAR" | "VEC2" | "VEC3", array: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>) =>
        this.doc.createAccessor().setType(type).setArray(array).setBuffer(this.buffer);
      mesh.addPrimitive(
        this.doc
          .createPrimitive()
          .setMaterial(material)
          .setIndices(acc("SCALAR", new Uint32Array(g.indices)))
          .setAttribute("POSITION", acc("VEC3", new Float32Array(g.positions)))
          .setAttribute("NORMAL", acc("VEC3", new Float32Array(g.normals)))
          .setAttribute("TEXCOORD_0", acc("VEC2", new Float32Array(g.uvs))),
      );
    }
    const node = this.doc.createNode(name).setMesh(mesh);
    parent.addChild(node);
    return node;
  }

  write(): Promise<Uint8Array> {
    return new NodeIO().writeBinary(this.doc);
  }
}

/** Recompute smooth vertex normals from the triangles (for surfaces built from grids). */
export function computeNormals(g: Geometry): Geometry {
  const n = new Array(g.positions.length).fill(0);
  for (let i = 0; i < g.indices.length; i += 3) {
    const [a, b, c] = [g.indices[i] * 3, g.indices[i + 1] * 3, g.indices[i + 2] * 3];
    const ux = g.positions[b] - g.positions[a], uy = g.positions[b + 1] - g.positions[a + 1], uz = g.positions[b + 2] - g.positions[a + 2];
    const vx = g.positions[c] - g.positions[a], vy = g.positions[c + 1] - g.positions[a + 1], vz = g.positions[c + 2] - g.positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      n[k] += nx;
      n[k + 1] += ny;
      n[k + 2] += nz;
    }
  }
  for (let k = 0; k < n.length; k += 3) {
    const l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
    n[k] /= l;
    n[k + 1] /= l;
    n[k + 2] /= l;
  }
  return { ...g, normals: n };
}

/** A (nu+1)×(nv+1) grid surface from a function of (u, v) in 0..1, triangulated counter-clockwise as seen from `front`. */
export function gridSurface(nu: number, nv: number, at: (u: number, v: number) => { p: [number, number, number]; uv: [number, number] }, flip = false): Geometry {
  const g: Geometry = { positions: [], normals: [], uvs: [], indices: [] };
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const { p, uv } = at(i / nu, j / nv);
      g.positions.push(...p);
      g.uvs.push(...uv);
    }
  const row = nu + 1;
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const a = j * row + i, b = a + 1, c = a + row + 1, d = a + row;
      g.indices.push(...(flip ? [a, c, b, a, d, c] : [a, b, c, a, c, d]));
    }
  return computeNormals(g);
}
