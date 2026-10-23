/** Colours painted on the generated fixtures (see scripts/make-fixtures.ts), shared with the tests. */
export const FACE_COLORS = {
  back: [230, 57, 70],
  left: [42, 157, 143],
  front: [38, 70, 83],
  right: [244, 162, 97],
  topHinge: [131, 56, 236], // top lid, half next to the fold (ends up at the back edge)
  topFar: [255, 190, 11], // top lid, far half (ends up at the front edge)
  bottomHinge: [58, 134, 255], // bottom lid, half next to the fold (front edge)
  bottomFar: [251, 86, 7],
} as const;

export const LABEL_COLORS = { left: [220, 38, 38], middle: [22, 163, 74], right: [37, 99, 235], topStrip: [250, 204, 21] } as const;
