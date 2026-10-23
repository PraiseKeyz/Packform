import sharp from "sharp";
import { GlbBuilder, computeNormals, gridSurface, type Geometry } from "./gltf";
import type { Point } from "./panels";
import { PT_TO_MM } from "./styles";

export type ContainerShape = "bottle" | "amber" | "jar" | "can" | "tube";

export interface ContainerOptions {
  /** Label size in mm (the trimmed label). */
  label: { width: number; height: number };
  /** Container style. Default "bottle" (clear water bottle). */
  shape?: ContainerShape;
  /** Diameter in mm. Default: the label wraps exactly once around (width ÷ π). */
  diameter?: number;
  /** Total height in mm, cap included. Default depends on the shape; grows if the label needs room. */
  height?: number;
  /** Cap or lid colour as #rrggbb. */
  capColor?: string;
  /** Body colour as #rrggbb. */
  bodyColor?: string;
  /** Body opacity 0-1 (1 = opaque). */
  bodyOpacity?: number;
  /** JPEG quality of the label texture. Default 90. */
  quality?: number;
}

type Profile = [radius: number, y: number][];
type Deform = (p: [number, number, number], H: number) => [number, number, number];

interface Preset {
  /** Default height as a multiple of the diameter. */
  heightRatio: number;
  body: { color: string; opacity: number; metallic: number; roughness: number };
  cap?: string;
  /** Profile of the body and the cap, and the straight zone where the label goes (as y values). */
  build: (r: number, H: number) => { body: Profile; cap?: Profile; zone: [number, number] };
  deform?: Deform;
  /** Label sits this much outside the body (fraction of the radius). */
  labelGap?: number;
}

const ease = (t: number) => (1 - Math.cos(Math.PI * t)) / 2;
/** Points along a smooth S-curve from (r0, y0) to (r1, y1). */
const sCurve = (r0: number, y0: number, r1: number, y1: number, steps = 14): Profile =>
  Array.from({ length: steps }, (_, k) => {
    const t = (k + 1) / steps;
    return [r0 + (r1 - r0) * ease(t), y0 + (y1 - y0) * t] as [number, number];
  });
/** Points along a quarter-round shoulder from (r0, y0) to (r1, y1): flat at the top, vertical at the side. */
const shoulder = (r0: number, y0: number, r1: number, y1: number, steps = 14): Profile =>
  Array.from({ length: steps }, (_, k) => {
    const a = ((k + 1) / steps) * (Math.PI / 2);
    return [r1 + (r0 - r1) * Math.cos(a), y0 + (y1 - y0) * Math.sin(a)] as [number, number];
  });

const PRESETS: Record<ContainerShape, Preset> = {
  // Clear PET water bottle
  bottle: {
    heightRatio: 3,
    body: { color: "#dcecf5", opacity: 0.45, metallic: 0, roughness: 0.12 },
    cap: "#1f5fbf",
    build: (r, H) => {
      const yS = H * 0.68, neck = r * 0.36, yN = H * 0.86;
      const capR = neck * 1.15;
      return {
        body: [[0, 0], [r * 0.9, 0], [r * 0.98, r * 0.03], [r, r * 0.1], [r, yS], ...sCurve(r, yS, neck, yN), [neck, H * 0.9]],
        cap: [[0, H * 0.875], [capR, H * 0.875], [capR, H - capR * 0.12], [capR * 0.92, H], [0, H]],
        zone: [r * 0.1, yS],
      };
    },
  },
  // Amber pharmacy bottle (Boston round) with a white child-resistant cap
  amber: {
    heightRatio: 2.1,
    body: { color: "#8a4a12", opacity: 0.88, metallic: 0, roughness: 0.15 },
    cap: "#f4f4f2",
    build: (r, H) => {
      const yS = H * 0.64, neck = r * 0.46, yN = H * 0.78;
      const capR = r * 0.56;
      return {
        body: [[0, 0], [r * 0.92, 0], [r, r * 0.06], [r, yS], ...shoulder(r, yS, neck, yN), [neck, H * 0.82]],
        cap: [[0, H * 0.77], [capR, H * 0.77], [capR, H - r * 0.04], [capR * 0.94, H], [0, H]],
        zone: [r * 0.08, yS],
      };
    },
  },
  // Wide glass jar with a screw lid
  jar: {
    heightRatio: 1.05,
    body: { color: "#e8f0ee", opacity: 0.35, metallic: 0, roughness: 0.08 },
    cap: "#2b2b2b",
    build: (r, H) => {
      const yS = H * 0.76, neck = r * 0.86, yN = H * 0.84;
      return {
        body: [[0, 0], [r * 0.9, 0], [r, r * 0.08], [r, yS], ...shoulder(r, yS, neck, yN, 8), [neck, H * 0.88]],
        cap: [[0, H * 0.84], [r * 0.93, H * 0.84], [r * 0.93, H - r * 0.03], [r * 0.9, H], [0, H]],
        zone: [r * 0.08, yS],
      };
    },
  },
  // Aluminium drinks can: the label is printed straight onto the metal
  can: {
    heightRatio: 1.75,
    body: { color: "#c9ced3", opacity: 1, metallic: 0.85, roughness: 0.3 },
    build: (r, H) => ({
      body: [
        [0, H * 0.035], [r * 0.75, 0], [r * 0.93, H * 0.012], [r, H * 0.06], [r, H * 0.86],
        ...sCurve(r, H * 0.86, r * 0.84, H * 0.955, 8), [r * 0.86, H * 0.975], [r * 0.84, H], [0, H * 0.985],
      ],
      zone: [H * 0.06, H * 0.86],
    }),
    labelGap: 0.002,
  },
  // Squeeze tube standing on its cap, crimped flat at the top
  tube: {
    heightRatio: 4,
    body: { color: "#f6f6f4", opacity: 1, metallic: 0, roughness: 0.4 },
    cap: "#ffffff",
    build: (r, H) => ({
      body: [[0, H * 0.12], [r * 0.62, H * 0.12], ...sCurve(r * 0.62, H * 0.12, r, H * 0.2, 8), [r, H * 0.985], [0, H * 0.985]],
      cap: [[0, 0], [r * 0.7, 0], [r * 0.72, H * 0.01], [r * 0.72, H * 0.12], [0, H * 0.12]],
      zone: [H * 0.22, H * 0.97],
    }),
    // Flatten towards the crimp: wider in x, thinner in z
    deform: ([x, y, z], H) => {
      const t = Math.max(0, Math.min(1, (y - H * 0.45) / (H * 0.54)));
      const k = t * t * (3 - 2 * t);
      return [x * (1 + 0.5 * k), y, z * (1 - 0.94 * k)];
    },
    labelGap: 0.003,
  },
};

/** Spin a profile (radius, height) around the Y axis. θ = 0 faces +Z (the front). UV v runs top (0) to bottom (1). */
export function lathe(profile: Profile, thetaStart = -Math.PI, thetaLength = Math.PI * 2, segments = 96): Geometry {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
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
      uvs.push(j / segments, 1 - i / (profile.length - 1));
    }
  }
  const row = segments + 1;
  for (let i = 0; i < profile.length - 1; i++)
    for (let j = 0; j < segments; j++) {
      const a = i * row + j, b = a + 1, c = a + row + 1, d = a + row;
      indices.push(a, b, c, a, c, d);
    }
  return { positions, normals, uvs, indices };
}

function deformed(g: Geometry, deform: Deform | undefined, H: number): Geometry {
  if (!deform) return g;
  const positions = g.positions.slice();
  for (let k = 0; k < positions.length; k += 3) {
    const [x, y, z] = deform([positions[k], positions[k + 1], positions[k + 2]], H);
    positions[k] = x;
    positions[k + 1] = y;
    positions[k + 2] = z;
  }
  return computeNormals({ ...g, positions });
}

/** Shift a geometry (in mm) to metres, centred vertically on `H / 2`. */
function toMetres(g: Geometry, H: number): Geometry {
  const positions = g.positions.map((v, k) => (k % 3 === 1 ? (v - H / 2) / 1000 : v / 1000));
  return { ...g, positions };
}

/**
 * Build a container (bottle, amber pharmacy bottle, jar, can or squeeze tube) with the label image
 * wrapped around it, as binary glTF. The label's horizontal centre faces the front (+Z).
 */
export async function buildContainerGlb(labelImage: Buffer, options: ContainerOptions): Promise<{ glb: Uint8Array; texture: Buffer }> {
  const shape = options.shape ?? "bottle";
  const preset = PRESETS[shape];
  const { label } = options;
  const D = options.diameter ?? label.width / Math.PI;
  const r = D / 2;
  // Make sure the label fits on the straight zone of the body
  let H = options.height ?? D * preset.heightRatio;
  for (let k = 0; k < 8; k++) {
    const [a, b] = preset.build(r, H).zone;
    if (b - a >= label.height * 1.04) break;
    H *= (label.height * 1.06) / (b - a);
  }
  const { body, cap, zone } = preset.build(r, H);

  const texture = await sharp(labelImage).jpeg({ quality: options.quality ?? 90 }).toBuffer();
  const out = new GlbBuilder();
  const b = preset.body;
  const opacity = options.bodyOpacity ?? b.opacity;
  const bodyMat = out.material("body", { color: options.bodyColor ?? b.color, opacity, metallic: b.metallic, roughness: b.roughness });
  const lr = r * (1 + (preset.labelGap ?? 0.004));
  const arc = Math.min(Math.PI * 2, label.width / r);
  const labelMat = out.material("label", { texture: { image: texture, mimeType: "image/jpeg" }, roughness: shape === "can" ? 0.35 : 0.5, metallic: shape === "can" ? 0.4 : 0, doubleSided: arc < Math.PI * 2 && opacity < 1 });

  const yMid = (zone[0] + zone[1]) / 2;
  const band: Profile = Array.from({ length: 9 }, (_, k) => [lr, yMid - label.height / 2 + (label.height * k) / 8]);
  const geo = (p: Profile, start?: number, len?: number) => toMetres(deformed(lathe(p, start, len), preset.deform, H), H);

  // Label first so it draws before a see-through body
  out.mesh("label", [{ geometry: geo(band, -arc / 2, arc), material: labelMat }]);
  if (cap) out.mesh("cap", [{ geometry: geo(cap), material: out.material("cap", { color: options.capColor ?? preset.cap, roughness: 0.45 }) }]);
  out.mesh("body", [{ geometry: geo(body), material: bodyMat }]);
  return { glb: await out.write(), texture };
}

/** A curved (cone) label: an annular sector on the flat sheet that wraps a tapered cup or tub. */
export interface ConeLabel {
  /** Centre of the arcs, in PDF points. */
  center: Point;
  /** Inner and outer radius, in PDF points. */
  r1: number;
  r2: number;
  /** Start and end angle of the sector (radians, page coordinates with y down), going through the middle. */
  a0: number;
  a1: number;
  /** Area of the page the label covers (for the texture). */
  bbox: [number, number, number, number];
}

/**
 * Build a tapered cup or tub with a cone label wrapped once around it. The wide end goes up when the
 * arcs bow upwards on the sheet (centre below the label), the narrow end up when they bow downwards.
 */
export async function buildCupGlb(labelImage: Buffer, cone: ConeLabel, options: { quality?: number; bodyColor?: string; rimColor?: string } = {}) {
  const { center, r1, r2, a0, a1, bbox } = cone;
  const phi = Math.abs(a1 - a0);
  const k = phi / (2 * Math.PI); // radius on the cup = k × radius on the sheet
  const cosB = Math.sqrt(Math.max(0, 1 - k * k));
  const mid = (a0 + a1) / 2;
  const wideTop = Math.sin(mid) < 0; // sector above its centre on the page (y grows downwards)
  const mmPt = PT_TO_MM;
  const R = (rho: number) => k * rho * mmPt;
  const Y = (rho: number) => (wideTop ? rho - r1 : r2 - rho) * cosB * mmPt;
  // Left edge of the label on the page wraps to the back-left, right edge to the back-right
  const xAt = (a: number) => center[0] + Math.cos(a) * (r1 + r2) / 2;
  const [aLeft, aRight] = xAt(a0) < xAt(a1) ? [a0, a1] : [a1, a0];

  const texture = await sharp(labelImage).jpeg({ quality: options.quality ?? 90 }).toBuffer();
  const out = new GlbBuilder();
  const labelMat = out.material("label", { texture: { image: texture, mimeType: "image/jpeg" }, roughness: 0.5 });
  const [bx0, by0, bx1, by1] = bbox;
  const height = Math.abs(Y(r2) - Y(r1));

  const labelAt = (u: number, v: number) => {
    const a = aLeft + (aRight - aLeft) * u;
    const rho = r2 - (r2 - r1) * v; // v = 0 along the outer arc
    const px = center[0] + Math.cos(a) * rho, py = center[1] + Math.sin(a) * rho;
    const theta = -Math.PI + 2 * Math.PI * u;
    const rr = R(rho) * 1.004;
    return { p: [rr * Math.sin(theta), Y(rho), rr * Math.cos(theta)] as [number, number, number], uv: [(px - bx0) / (bx1 - bx0), (py - by0) / (by1 - by0)] as [number, number] };
  };
  let labelGeo = gridSurface(96, 8, labelAt);
  // Make sure the printed side faces outwards
  if (labelGeo.normals[0] * labelGeo.positions[0] + labelGeo.normals[2] * labelGeo.positions[2] < 0) labelGeo = gridSurface(96, 8, labelAt, true);

  // Cup body: the same taper, a little taller than the label, closed at the narrow end with a rolled rim at the wide end
  const ext = height * 0.08;
  const slope = (R(r2) - R(r1)) / (Y(r2) - Y(r1)); // dR / dy
  const yLo = Math.min(Y(r1), Y(r2)) - ext, yHi = Math.max(Y(r1), Y(r2)) + ext;
  const rAt = (y: number) => R(r1) + slope * (y - Y(r1));
  const rim = yHi;
  const body: Profile = [[0, yLo], [rAt(yLo) * 0.97, yLo], [rAt(yLo), yLo + ext * 0.2], [rAt(rim), rim]];
  const wideEndUp = rAt(yHi) > rAt(yLo);
  const rimProfile: Profile = Array.from({ length: 9 }, (_, i) => {
    const t = (i / 8) * Math.PI;
    const rr = rAt(rim) + (wideEndUp ? 1 : -1) * 1.2 * (1 - Math.cos(t)) * 0.5;
    return [rr, rim + Math.sin(t) * 1.2] as [number, number];
  });
  const totalH = yHi + 1.2;
  const m = (g: Geometry) => toMetres(g, totalH + yLo);
  const bodyMat = out.material("cup", { color: options.bodyColor ?? "#f7f5ef", roughness: 0.6, doubleSided: true });
  out.mesh("label", [{ geometry: m(labelGeo), material: labelMat }]);
  out.mesh("cup", [{ geometry: m(lathe(body)), material: bodyMat }, { geometry: m(lathe(rimProfile)), material: out.material("rim", { color: options.rimColor ?? "#ffffff", roughness: 0.5 }) }]);
  return { glb: await out.write(), texture };
}
