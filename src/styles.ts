import type { Segment } from "./pdf";

/** How a group of lines is drawn. Dielines use one style per job (cut, fold, bleed, …), but colours vary between tools. */
export interface LineStyle {
  color: [number, number, number];
  width: number;
  dashed: boolean;
}

export const styleKey = (s: LineStyle) => `${s.color.join(",")}|${s.width.toFixed(2)}|${s.dashed ? "dashed" : "solid"}`;

export const styleOf = (s: Segment): LineStyle => ({ color: s.color, width: s.width, dashed: s.dashed });

/** Group segments by how they are drawn. */
export function lineStyles(segments: Segment[]): { style: LineStyle; segments: Segment[] }[] {
  const groups = new Map<string, { style: LineStyle; segments: Segment[] }>();
  for (const s of segments) {
    const style = styleOf(s);
    const key = styleKey(style);
    if (!groups.has(key)) groups.set(key, { style, segments: [] });
    groups.get(key)!.segments.push(s);
  }
  return [...groups.values()];
}

export function describeStyle(s: LineStyle) {
  const hex = "#" + s.color.map((c) => c.toString(16).padStart(2, "0")).join("");
  return `${s.dashed ? "dashed" : "solid"} ${hex} ${s.width.toFixed(2)}pt`;
}

export const segLength = (s: Segment) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
export const PT_TO_MM = 25.4 / 72;
