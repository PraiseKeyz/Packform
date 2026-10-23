import earcut from "earcut";
import sharp from "sharp";
import { GlbBuilder, computeNormals, gridSurface, type Geometry } from "./gltf";
import type { Rect } from "./pdf";
import type { Point } from "./panels";
import { PT_TO_MM } from "./styles";

const MM = PT_TO_MM; // mm per point

export interface BlisterLayout {
  kind: "blister";
  /** Card / foil outline, in PDF points. */
  card: Point[];
  cardBox: Rect;
  /** Each cavity (pocket for a tablet or capsule): its box and how rounded it is (0.785 = ellipse, ~1 = rectangle). */
  cavities: { box: Rect; fill: number }[];
  size: { width: number; height: number };
  linesPage: number;
}

export interface PillowLayout {
  kind: "sachet" | "pouch";
  front: Rect;
  back?: Rect;
  /** Pouch bottom gusset artwork, when the template has it. */
  gusset?: Rect;
  size: { width: number; height: number };
  linesPage: number;
}

const jpeg = (img: Buffer, quality = 90) => sharp(img).jpeg({ quality }).toBuffer();

/** Flat polygon (points, page coords) → triangles in mm with y up, centred on `origin`, at height z. */
function flatPolygon(poly: Point[], origin: Point, z: number, uvBox: Rect, flipU = false, facing: 1 | -1 = 1): Geometry {
  const ring = poly.map(([x, y]) => [(x - origin[0]) * MM, -(y - origin[1]) * MM]);
  let tris = earcut(ring.flat());
  const ccw = (i: number) => {
    const [a, b, c] = [ring[tris[i]], ring[tris[i + 1]], ring[tris[i + 2]]];
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0;
  };
  if (tris.length && ccw(0) !== (facing > 0)) {
    const t: number[] = [];
    for (let k = 0; k < tris.length; k += 3) t.push(tris[k], tris[k + 2], tris[k + 1]);
    tris = t;
  }
  const [bx0, by0, bx1, by1] = uvBox;
  return {
    positions: ring.flatMap(([x, y]) => [x, y, z]),
    normals: ring.flatMap(() => [0, 0, facing]),
    uvs: poly.flatMap(([x, y]) => {
      const u = (x - bx0) / (bx1 - bx0);
      return [flipU ? 1 - u : u, (y - by0) / (by1 - by0)];
    }),
    indices: tris,
  };
}

const metres = (g: Geometry): Geometry => ({ ...g, positions: g.positions.map((v) => v / 1000) });

/** Superellipse point: n = 2 is an ellipse, larger n is squarer. */
const superellipse = (t: number, a: number, b: number, n: number): [number, number] => {
  const c = Math.cos(t), s = Math.sin(t);
  return [a * Math.sign(c) * Math.abs(c) ** (2 / n), b * Math.sign(s) * Math.abs(s) ** (2 / n)];
};

/**
 * Build a blister pack: the printed card or foil, clear domes over each cavity, and tablets or capsules inside.
 * `artwork` covers `layout.cardBox`.
 */
export async function buildBlisterGlb(artwork: Buffer, layout: BlisterLayout, options: { quality?: number; pillColor?: string; foilColor?: string } = {}) {
  const texture = await jpeg(artwork, options.quality);
  const out = new GlbBuilder();
  const [x0, y0, x1, y1] = layout.cardBox;
  const origin: Point = [(x0 + x1) / 2, (y0 + y1) / 2];
  const thick = 0.4; // mm
  const printed = out.material("card", { texture: { image: texture, mimeType: "image/jpeg" }, roughness: 0.45 });
  const foil = out.material("foil", { color: options.foilColor ?? "#cfd3d8", metallic: 0.8, roughness: 0.35 });
  const pvc = out.material("pvc", { color: "#eef6fb", opacity: 0.3, roughness: 0.05 });
  const pill = out.material("tablet", { color: options.pillColor ?? "#fafaf5", roughness: 0.6 });

  out.mesh("card", [
    { geometry: metres(flatPolygon(layout.card, origin, thick / 2, layout.cardBox)), material: printed },
    { geometry: metres(flatPolygon(layout.card, origin, -thick / 2, layout.cardBox, false, -1)), material: foil },
  ]);

  for (const [i, c] of layout.cavities.entries()) {
    const [cx0, cy0, cx1, cy1] = c.box;
    const a = ((cx1 - cx0) / 2) * MM, b = ((cy1 - cy0) / 2) * MM;
    const cx = ((cx0 + cx1) / 2 - origin[0]) * MM, cy = -((cy0 + cy1) / 2 - origin[1]) * MM;
    const n = c.fill > 0.9 ? 6 : c.fill > 0.83 ? 3.5 : 2;
    const h = Math.min(Math.min(a, b) * 0.9, 7);
    const dome = gridSurface(48, 12, (u, v) => {
      const [ex, ey] = superellipse(u * Math.PI * 2, a, b, n);
      const k = Math.cos((v * Math.PI) / 2); // 1 at the rim, 0 at the top
      return { p: [cx + ex * k, cy + ey * k, thick / 2 + h * Math.sin((v * Math.PI) / 2)], uv: [u, v] };
    });
    // Tablet (round) or capsule (long): a flattened, rounded shape inside the dome
    const capsule = Math.max(a, b) / Math.min(a, b) > 1.6;
    const tablet = gridSurface(32, 16, (u, v) => {
      const t = u * Math.PI * 2, phi = -Math.PI / 2 + v * Math.PI;
      const [ex, ey] = superellipse(t, a * 0.8, b * 0.8, capsule ? 3 : 2);
      const k = Math.cos(phi);
      const zr = (capsule ? Math.min(a, b) * 0.75 : h * 0.4) / 2;
      return { p: [cx + ex * k, cy + ey * k, thick / 2 + zr + 0.1 + zr * Math.sin(phi)], uv: [u, v] };
    }, true);
    out.mesh(`cavity-${i}`, [
      { geometry: metres(dome), material: pvc },
      { geometry: metres(tablet), material: pill },
    ]);
  }
  return { glb: await out.write(), texture };
}

/**
 * Build a sachet (flat, puffed pillow with sealed edges) or a stand-up pouch (fuller at the bottom, with a gusset
 * it stands on). Images: front, and optionally back and gusset artwork.
 */
export async function buildPillowGlb(
  images: { front: Buffer; back?: Buffer; gusset?: Buffer },
  layout: PillowLayout,
  options: { quality?: number; puff?: number } = {},
) {
  const out = new GlbBuilder();
  const W = layout.size.width, H = layout.size.height;
  const pouch = layout.kind === "pouch";
  const seal = { side: Math.max(2.5, W * 0.035), top: Math.max(3, H * 0.05), bottom: pouch ? 0 : Math.max(3, H * 0.05) };
  const T = (options.puff ?? (pouch ? 0.16 : 0.07)) * Math.min(W, H);
  const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : Math.sin(t * Math.PI) ** 0.55);

  // Thickness at (u, v), u across, v up from the bottom. Pouches bulge most near the bottom and stay open there.
  const depth = (u: number, v: number) => {
    const x = u * W, y = v * H;
    const fx = smooth((x - seal.side) / (W - 2 * seal.side));
    if (pouch) {
      const fy = y > H - seal.top ? 0 : Math.min(1, ((H - seal.top - y) / (H * 0.35)) ** 0.6);
      return T * fx * fy * (0.45 + 0.55 * (1 - v) ** 1.2);
    }
    const fy = smooth((y - seal.bottom) / (H - seal.top - seal.bottom));
    return T * fx * fy;
  };

  const front = await jpeg(images.front, options.quality);
  const frontMat = out.material("front", { texture: { image: front, mimeType: "image/jpeg" }, roughness: pouch ? 0.35 : 0.3, metallic: pouch ? 0 : 0.15 });
  const backMat = images.back
    ? out.material("back", { texture: { image: await jpeg(images.back, options.quality), mimeType: "image/jpeg" }, roughness: 0.35 })
    : out.material("back", { color: "#e9e9e9", roughness: 0.4, metallic: 0.2 });

  const eps = 0.08; // keep the two faces apart at the seals
  const side = (sign: 1 | -1) =>
    gridSurface(64, 80, (u, v) => ({
      p: [(u - 0.5) * W, (v - 0.5) * H, sign * (eps + depth(u, v))],
      // Seen from behind, the back image must not be mirrored
      uv: [sign > 0 ? u : 1 - u, 1 - v],
    }), sign < 0);
  out.mesh(layout.kind, [
    { geometry: metres(side(1)), material: frontMat },
    { geometry: metres(side(-1)), material: backMat },
  ]);

  if (pouch) {
    // Bottom gusset: closes the gap between the front and back bottom edges; the pouch stands on it
    const gussetMat = images.gusset
      ? out.material("gusset", { texture: { image: await jpeg(images.gusset, options.quality), mimeType: "image/jpeg" }, roughness: 0.4 })
      : out.material("gusset", { color: "#e2e2e2", roughness: 0.5 });
    const g: Geometry = gridSurface(64, 6, (u, v) => {
      const z = (eps + depth(u, 0)) * (1 - 2 * v);
      return { p: [(u - 0.5) * W, -H / 2, z], uv: [u, v] };
    }, true);
    out.mesh("gusset", [{ geometry: metres(computeNormals(g)), material: gussetMat }]);
  }
  return { glb: await out.write(), texture: front };
}
