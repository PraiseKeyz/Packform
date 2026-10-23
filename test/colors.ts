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

export const FLAT_COLORS = {
  base: [46, 125, 50], // tray / mailer base
  wall: [255, 167, 38],
  lid: [21, 101, 192],
  flap: [189, 189, 189],
  sachetFront: [233, 30, 99],
  sachetBack: [3, 169, 244],
  gusset: [255, 235, 59],
  blister: [0, 137, 123],
} as const;

/** Sizes (mm) the fixtures are drawn at. */
export const FIXTURE_SIZES = {
  tuckEnd: { w: 50, h: 120, d: 35 },
  tray: { l: 120, w: 80, h: 30 },
  mailer: { w: 150, l: 110, h: 40 },
  sleeve: { w: 60, h: 90, d: 30 },
  crashLock: { w: 60, h: 100, d: 40 },
  cup: { top: 90, bottom: 60, height: 90 },
  blister: { w: 120, h: 60, rows: 2, cols: 5, cavity: 14 },
  sachet: { w: 80, h: 110 },
  pouch: { w: 120, h: 170, gusset: 40 },
  label: { w: 200, h: 60 },
} as const;
