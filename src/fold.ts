import { Document, NodeIO, type Node } from "@gltf-transform/core";
import earcut from "earcut";
import { IDENTITY_Q, apply, applyDir, fromTR, mul, normalize, quatAxisAngle, quatMul, rotate, sub, type Mat4, type Quat, type Vec3 } from "./math";
import type { PageInfo, Rect } from "./pdf";
import { analyzePanels, type Hinge, type Panel, type PanelAnalysis, type Point } from "./panels";
import { PT_TO_MM, type LineStyle } from "./styles";

/** A panel placed in the folding tree. */
export interface FoldedPanel extends Panel {
  /** Panel it hangs from (-1 for the root). */
  parent: number;
  /** The fold it turns about, in PDF points. */
  hinge?: { p1: Point; p2: Point };
  /** Fold angle in radians (signed, around p1 → p2). */
  angle: number;
  /** When it folds in the animation: stage n folds between n and n + 1 seconds. */
  stage: number;
  /**
   * How it moves in the animation:
   * - "fold": turns over its whole stage
   * - "lid": waits while its tuck and flaps are bent, then closes
   * - "tuck": bent to 90° before its lid moves, then held upright so it slides inside the box as the lid closes
   * - "lid-flap": a side flap on a lid, bent before the lid moves
   */
  motion: "fold" | "lid" | "tuck" | "lid-flap";
  /** Tucks only: depth of the lid it hangs from and of the tuck itself, in points (to keep it inside the box). */
  tuck?: { lidDepth: number; depth: number };
}

export interface CartonLayout {
  kind: "carton";
  /** Size of the folded carton in millimetres (width = x, height = y, depth = z). */
  size: { width: number; height: number; depth: number };
  panels: FoldedPanel[];
  root: number;
  /** "standing" for tall cartons; "base-down" when the main panel is a base (trays, mailer boxes). */
  orientation: "standing" | "base-down";
  foldStyle: LineStyle;
  /** Area of the page covered by the panels, in PDF points (the texture covers this). */
  bbox: Rect;
  /** Length of the fold animation in seconds. */
  duration: number;
  linesPage: number;
}

export interface CartonOptions {
  /** Fold angle in degrees for every fold. Default 90. */
  foldAngle?: number;
}

const M_PER_PT = PT_TO_MM / 1000;
const FPS = 30;
/** Flat page point → metres, y up, on the z = 0 plane (the printed side faces +z). */
const flat = ([x, y]: Point): Vec3 => [x * M_PER_PT, -y * M_PER_PT, 0];

/** Which side of a panel a hinge sits on. */
function sideOf(p: Panel, h: Hinge): "top" | "bottom" | "left" | "right" | undefined {
  const [x0, y0, x1, y1] = p.bbox;
  const mid: Point = [(h.p1[0] + h.p2[0]) / 2, (h.p1[1] + h.p2[1]) / 2];
  const horizontal = Math.abs(h.p2[1] - h.p1[1]) < 0.1 * h.length;
  const vertical = Math.abs(h.p2[0] - h.p1[0]) < 0.1 * h.length;
  const tol = 4;
  if (horizontal && Math.abs(mid[1] - y0) < tol) return "top";
  if (horizontal && Math.abs(mid[1] - y1) < tol) return "bottom";
  if (vertical && Math.abs(mid[0] - x0) < tol) return "left";
  if (vertical && Math.abs(mid[0] - x1) < tol) return "right";
  return undefined;
}

/**
 * Work out how a carton folds: find its panels and folds, pick the main panel, and fold every
 * other panel 90° away from the printed side about its hinge. Works for any carton built from
 * panels joined by straight folds: tuck-end, crash-lock, trays, mailers, sleeves, lids.
 */
export function detectCarton(page: PageInfo, options: CartonOptions = {}, analysis: PanelAnalysis = analyzePanels(page)): CartonLayout {
  const { panels: all, hinges: allHinges, foldStyle } = analysis;
  if (!foldStyle || allHinges.length < 2) throw new Error("No panels joined by fold lines.");

  // Maximum spanning tree over the folds (longest hinges first), so every panel hangs from exactly one parent
  const parentOf = all.map((_, i) => i);
  const find = (i: number): number => (parentOf[i] === i ? i : (parentOf[i] = find(parentOf[i])));
  const tree: Hinge[] = [];
  for (const h of [...allHinges].sort((a, b) => b.length - a.length)) {
    const ra = find(h.a), rb = find(h.b);
    if (ra === rb) continue;
    parentOf[ra] = rb;
    tree.push(h);
  }
  // Keep the biggest connected group of panels (drops legends, info boxes, stray shapes)
  const groups = new Map<number, number[]>();
  all.forEach((_, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  });
  const members = [...groups.values()].sort((a, b) => b.reduce((s, i) => s + all[i].area, 0) - a.reduce((s, i) => s + all[i].area, 0))[0];
  if (members.length < 5) throw new Error(`Only ${members.length} panels are joined by folds; a carton needs at least 5.`);
  const inGroup = new Set(members);
  const hinges = tree.filter((h) => inGroup.has(h.a));

  // Main (root) panel: one of the biggest. Prefer one without anything hanging off its top edge (the front of a
  // tuck-end carton rather than the back that carries the lid), then the one with the fewest folds (a mailer's lid
  // rather than its base). If the choice still has folds on all four sides it is a base (a tray): it lies face down.
  const maxArea = Math.max(...members.map((i) => all[i].area));
  const incident = (i: number) => allHinges.filter((h) => (h.a === i || h.b === i) && inGroup.has(h.a) && inGroup.has(h.b));
  const sides = (i: number) => new Set(incident(i).map((h) => sideOf(all[i], h)).filter(Boolean));
  const candidates = members.filter((i) => all[i].area >= maxArea * 0.97);
  // last tie-breaks: bigger neighbours (a mailer's base has walls around it, its lid only flaps), then leftmost
  const neighbourArea = (i: number) => incident(i).reduce((s, h) => s + all[h.a === i ? h.b : h.a].area, 0);
  const root = [...candidates].sort(
    (a, b) =>
      Number(sides(a).has("top")) - Number(sides(b).has("top")) ||
      incident(a).length - incident(b).length ||
      neighbourArea(b) - neighbourArea(a) ||
      all[a].bbox[0] - all[b].bbox[0],
  )[0];
  const base = sides(root).size === 4 ? root : undefined;

  // Walk the tree from the root
  const children = new Map<number, { child: number; hinge: Hinge }[]>();
  for (const h of hinges) {
    children.set(h.a, [...(children.get(h.a) ?? []), { child: h.b, hinge: h }]);
    children.set(h.b, [...(children.get(h.b) ?? []), { child: h.a, hinge: h }]);
  }
  const maxHinge = Math.max(...hinges.map((h) => h.length));
  const angle = ((options.foldAngle ?? 90) * Math.PI) / 180;
  const folded = new Map<number, FoldedPanel>();
  folded.set(root, { ...all[root], parent: -1, angle: 0, stage: 0, motion: "fold" });
  const order = [root];
  for (let k = 0; k < order.length; k++) {
    const p = order[k];
    for (const { child, hinge } of children.get(p) ?? []) {
      if (folded.has(child)) continue;
      // Fold away from the printed side: choose the sign that sends the panel to -z
      const axis = normalize(sub(flat(hinge.p2), flat(hinge.p1)));
      const c = sub(flat(all[child].centroid), flat(hinge.p1));
      const sign = rotate(quatAxisAngle(axis, angle), c)[2] < 0 ? 1 : -1;
      folded.set(child, { ...all[child], parent: p, hinge: { p1: hinge.p1, p2: hinge.p2 }, angle: sign * angle, stage: 0, motion: "fold" });
      order.push(child);
    }
  }

  // Animation stages: the main walls first, then the flaps on them, then the lids. A lid's own tuck and flaps move
  // in the same stage as the lid: bent first, then carried inside as it closes, the way the board is closed by hand.
  const isLeaf = (i: number) => !(children.get(i) ?? []).some(({ child }) => folded.get(child)?.parent === i);
  const hingeDir = (f: FoldedPanel): Point => {
    const dx = f.hinge!.p2[0] - f.hinge!.p1[0], dy = f.hinge!.p2[1] - f.hinge!.p1[1], l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  // distance of a point from a fold line, in points
  const offLine = (f: FoldedPanel, [x, y]: Point) => {
    const [dx, dy] = hingeDir(f);
    return Math.abs((x - f.hinge!.p1[0]) * dy - (y - f.hinge!.p1[1]) * dx);
  };
  for (const i of order.slice(1)) {
    const f = folded.get(i)!, parent = folded.get(f.parent)!;
    const hingeLen = Math.hypot(f.hinge!.p2[0] - f.hinge!.p1[0], f.hinge!.p2[1] - f.hinge!.p1[1]);
    // the first step: the walls round a base (trays, mailers), or the long wall folds of a standing carton
    const strip = parent.stage === 0 && (base !== undefined ? f.parent === root : hingeLen >= maxHinge * 0.9);
    if (strip) f.stage = 0;
    else if (parent.motion === "lid" && isLeaf(i)) {
      f.stage = parent.stage;
      const [ax, ay] = hingeDir(f), [bx, by] = hingeDir(parent);
      if (Math.abs(ax * bx + ay * by) > 0.9) {
        // a tuck on the far edge of its lid
        const mid: Point = [(f.hinge!.p1[0] + f.hinge!.p2[0]) / 2, (f.hinge!.p1[1] + f.hinge!.p2[1]) / 2];
        f.motion = "tuck";
        f.tuck = { lidDepth: offLine(parent, mid), depth: Math.max(...f.polygon.map((pt) => offLine(f, pt))) };
      } else f.motion = "lid-flap";
    } else if (isLeaf(i)) f.stage = parent.stage + 1;
    else {
      // A narrow strip carrying a bigger panel is the rim of a double wall (mailer fronts): it folds in with the flaps,
      // before the lids close over it. Anything else is a lid.
      const kids = (children.get(i) ?? []).filter(({ child }) => !folded.has(child) || folded.get(child)!.parent === i).map(({ child }) => all[child].area);
      f.stage = parent.stage + (f.area < 0.5 * Math.max(0, ...kids) ? 1 : 2);
      f.motion = "lid";
    }
  }
  // close up gaps in the numbering (e.g. no flaps between the walls and the lids)
  const used = [...new Set([...folded.values()].map((f) => f.stage))].sort((a, b) => a - b);
  for (const f of folded.values()) f.stage = used.indexOf(f.stage);

  // Renumber panels 0..n-1 in tree order
  const renumber = new Map(order.map((old, i) => [old, i]));
  const panels = order.map((old, i) => {
    const f = folded.get(old)!;
    return { ...f, id: i, parent: f.parent < 0 ? -1 : renumber.get(f.parent)! };
  });

  const xs = panels.flatMap((p) => [p.bbox[0], p.bbox[2]]), ys = panels.flatMap((p) => [p.bbox[1], p.bbox[3]]);
  const layout: CartonLayout = {
    kind: "carton",
    size: { width: 0, height: 0, depth: 0 },
    panels,
    root: 0,
    orientation: base !== undefined ? "base-down" : "standing",
    foldStyle,
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    duration: Math.max(...panels.map((p) => p.stage)) + 1,
    linesPage: page.index,
  };
  const { min, max } = foldedBounds(layout);
  const mm = (m: number) => Math.round(m * 1000 * 2) / 2;
  layout.size = { width: mm(max[0] - min[0]), height: mm(max[1] - min[1]), depth: mm(max[2] - min[2]) };
  return layout;
}

/** Turn a "base-down" carton so its base faces the floor. */
function orientation(layout: CartonLayout): Quat {
  if (layout.orientation === "standing") return IDENTITY_Q;
  const rx = quatAxisAngle([1, 0, 0], Math.PI / 2);
  const ry = quatAxisAngle([0, 1, 0], Math.PI);
  return quatMul(ry, rx);
}

interface NodeFrame {
  /** Origin in flat coordinates (metres). */
  origin: Vec3;
  /** Translation relative to the parent's origin. */
  translation: Vec3;
  /** The fold line's direction (rotation axis). */
  axis: Vec3;
  /** Rotation when fully folded. */
  rotation: Quat;
}

function frames(layout: CartonLayout): NodeFrame[] {
  const out: NodeFrame[] = [];
  for (const p of layout.panels) {
    if (p.parent < 0) {
      out.push({ origin: flat(p.centroid), translation: flat(p.centroid), axis: [0, 0, 1], rotation: IDENTITY_Q });
      continue;
    }
    const origin = flat(p.hinge!.p1);
    const axis = normalize(sub(flat(p.hinge!.p2), origin));
    out.push({ origin, translation: sub(origin, out[p.parent].origin), axis, rotation: quatAxisAngle(axis, p.angle) });
  }
  return out;
}

/** Share of a lid's stage spent bending its tuck and flaps before the lid starts to close. */
const PRE_BEND = 0.35;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => x * x * (3 - 2 * x);

/** A panel's fold angle (radians, signed) at time `t` seconds into the fold animation. */
export function foldAngleAt(layout: CartonLayout, panel: number, t: number): number {
  const p = layout.panels[panel];
  if (p.parent < 0) return 0;
  const sign = Math.sign(p.angle), full = Math.abs(p.angle);
  const s = t - p.stage;
  switch (p.motion) {
    case "fold":
      return sign * full * ease(clamp01(s));
    case "lid":
      return sign * full * ease(clamp01((s - PRE_BEND) / (1 - PRE_BEND)));
    case "lid-flap":
      return sign * full * ease(clamp01(s / PRE_BEND));
    case "tuck": {
      if (s < PRE_BEND) return sign * full * ease(clamp01(s / PRE_BEND));
      // While the lid closes, bend the tuck a little further so it stays pointing into the box instead of sweeping
      // through the wall it tucks behind. `left` is how far the lid still has to go; below `critical` the tuck is
      // held straight down, above it the extra bend eases in from nothing.
      const lidAngle = Math.abs(layout.panels[p.parent].angle);
      const left = lidAngle * (1 - ease(clamp01((s - PRE_BEND) / (1 - PRE_BEND))));
      const { lidDepth, depth } = p.tuck!;
      const critical = Math.min(lidAngle, Math.asin(Math.min(1, depth / Math.max(lidDepth, 1e-6))) + 0.12);
      const extra = left <= critical || lidAngle - critical < 1e-6 ? left : (critical * (lidAngle - left)) / (lidAngle - critical);
      return sign * (full + extra);
    }
  }
}

/**
 * World matrix of every panel at a point in the fold animation (progress 0 = flat, 1 = folded).
 * Matrices map flat coordinates relative to each panel's origin; use `panelPoint` to place a page point.
 */
export function panelMatrices(layout: CartonLayout, progress = 1, centered = true): Mat4[] {
  const fr = frames(layout);
  const t = progress * layout.duration;
  const out: Mat4[] = [];
  for (let i = 0; i < layout.panels.length; i++) {
    const p = layout.panels[i];
    const m = fromTR(fr[i].translation, p.parent < 0 ? IDENTITY_Q : quatAxisAngle(fr[i].axis, foldAngleAt(layout, i, t)));
    out.push(p.parent < 0 ? m : mul(out[p.parent], m));
  }
  const top = fromTR(centered ? centerOffset(layout) : [0, 0, 0], orientation(layout));
  return out.map((m) => mul(top, m));
}

/** Where a point of the flat page ends up in 3D for a given panel (metres). */
export function panelPoint(layout: CartonLayout, matrices: Mat4[], panel: number, pt: Point): Vec3 {
  const fr = frames(layout);
  return apply(matrices[panel], sub(flat(pt), fr[panel].origin));
}

/** Outward (printed side) normal of a panel. */
export const panelNormal = (matrices: Mat4[], panel: number): Vec3 => normalize(applyDir(matrices[panel], [0, 0, 1]));

function foldedBounds(layout: CartonLayout) {
  const m = panelMatrices(layout, 1, false);
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  layout.panels.forEach((p, i) => {
    for (const pt of p.polygon) {
      const v = panelPoint(layout, m, i, pt);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], v[k]);
        max[k] = Math.max(max[k], v[k]);
      }
    }
  });
  return { min, max };
}

function centerOffset(layout: CartonLayout): Vec3 {
  const { min, max } = foldedBounds(layout);
  return [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -(min[2] + max[2]) / 2];
}

export interface CartonGlbOptions {
  /** Colour of the unprinted inside of the board. Default #ece6da. */
  boardColor?: string;
  /** Include the fold animation. Default true. */
  animation?: boolean;
}

const srgbToLinear = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.pow(v / 255, 2.2)) as [number, number, number];
};

/**
 * Build the carton as binary glTF: one node per panel, nested along the folds, so the model can be
 * shown folded (the default pose) or animated from flat to folded with the "fold" animation.
 * `texture` is the artwork covering `layout.bbox`.
 */
export async function buildCartonGlb(layout: CartonLayout, texture: Buffer, mimeType: "image/jpeg" | "image/png", options: CartonGlbOptions = {}) {
  const fr = frames(layout);
  const [bx0, by0, bx1, by1] = layout.bbox;
  const maxArea = Math.max(...layout.panels.map((p) => p.area));

  const doc = new Document();
  const buffer = doc.createBuffer();
  const tex = doc.createTexture("artwork").setImage(new Uint8Array(texture)).setMimeType(mimeType);
  const printed = doc.createMaterial("printed").setBaseColorTexture(tex).setMetallicFactor(0).setRoughnessFactor(0.55);
  const board = doc.createMaterial("board").setBaseColorFactor([...srgbToLinear(options.boardColor ?? "#ece6da"), 1]).setMetallicFactor(0).setRoughnessFactor(0.9);

  const centre = centerOffset(layout);
  const top = doc.createNode("packform").setRotation(orientation(layout));
  top.setTranslation(centre); // glTF applies the rotation first, then this offset, matching panelMatrices
  doc.createScene("scene").addChild(top);

  const nodes: Node[] = [];
  layout.panels.forEach((p, i) => {
    // Smaller panels sit slightly further inside, so overlapping flaps don't flicker (dust flaps under the lid, etc.)
    const inset = 0.0006 * (1 - p.area / maxArea);
    const ring = p.polygon.map((pt) => sub(flat(pt), fr[i].origin));
    let tris = earcut(ring.flatMap((v) => [v[0], v[1]]));
    // Make the printed side face +z (counter-clockwise seen from the front)
    if (tris.length >= 3) {
      const [a, b, c] = [ring[tris[0]], ring[tris[1]], ring[tris[2]]];
      if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0) {
        const flipped: number[] = [];
        for (let k = 0; k < tris.length; k += 3) flipped.push(tris[k], tris[k + 2], tris[k + 1]);
        tris = flipped;
      }
    }
    const uv = p.polygon.flatMap(([x, y]) => [(x - bx0) / (bx1 - bx0), (y - by0) / (by1 - by0)]);
    const prim = (z: number, normal: number, reverse: boolean, material: typeof printed) => {
      const pos = ring.flatMap((v) => [v[0], v[1], z]);
      const nor = ring.flatMap(() => [0, 0, normal]);
      const idx: number[] = [];
      for (let k = 0; k < tris.length; k += 3) idx.push(...(reverse ? [tris[k], tris[k + 2], tris[k + 1]] : [tris[k], tris[k + 1], tris[k + 2]]));
      return doc
        .createPrimitive()
        .setMaterial(material)
        .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(idx)).setBuffer(buffer))
        .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(pos)).setBuffer(buffer))
        .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(nor)).setBuffer(buffer))
        .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(uv)).setBuffer(buffer));
    };
    const mesh = doc
      .createMesh(`panel-${i}`)
      .addPrimitive(prim(-inset, 1, false, printed))
      .addPrimitive(prim(-inset - 0.00015, -1, true, board));
    const node = doc.createNode(`panel-${i}`).setMesh(mesh).setTranslation(fr[i].translation).setRotation(fr[i].rotation);
    (p.parent < 0 ? top : nodes[p.parent]).addChild(node);
    nodes.push(node);
  });

  if (options.animation !== false) {
    // Sample the motion 30 times a second (the moves are eased and tucks bend twice, so two keyframes aren't enough)
    const anim = doc.createAnimation("fold");
    const steps = Math.round(layout.duration * FPS);
    const times = Array.from({ length: steps + 1 }, (_, k) => (k / steps) * layout.duration);
    const input = doc.createAccessor().setType("SCALAR").setArray(new Float32Array(times)).setBuffer(buffer);
    layout.panels.forEach((p, i) => {
      if (p.parent < 0) return;
      const values = times.flatMap((t) => quatAxisAngle(fr[i].axis, foldAngleAt(layout, i, t)));
      const sampler = doc
        .createAnimationSampler()
        .setInput(input)
        .setOutput(doc.createAccessor().setType("VEC4").setArray(new Float32Array(values)).setBuffer(buffer))
        .setInterpolation("LINEAR");
      anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(nodes[i]).setTargetPath("rotation").setSampler(sampler));
    });
  }

  return new NodeIO().writeBinary(doc);
}
