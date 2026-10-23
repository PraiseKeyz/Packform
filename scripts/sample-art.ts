/**
 * Paint made-up product artwork onto the downloaded sample dielines (they ship without artwork),
 * then build their 3D models. Output goes to samples/, which is not committed.
 *
 *   npx tsx scripts/sample-art.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { choosePages, detectDieline, dielineToGlb, openPdf, panelMatrices, readPage, type FaceName, type Rect } from "../src/index";
import { applyDir } from "../src/math";

const S = 4; // pixels per PDF point (288 dpi)
const dir = new URL("../samples/", import.meta.url).pathname;

async function layoutOf(file: string) {
  const doc = await openPdf(readFileSync(file));
  const page = await readPage(await doc.getPage(choosePages([await readPage(await doc.getPage(1))]).lines.index + 1));
  await doc.destroy();
  return { page, layout: detectDieline(page) };
}

/** Draw upright content into a panel that the 3D build will turn by `rotate` degrees clockwise. */
function panel(ctx: SKRSContext2D, rect: Rect, rotate: number, paint: (w: number, h: number) => void) {
  const [x0, y0, x1, y1] = rect.map((v) => v * S);
  let w = x1 - x0, h = y1 - y0;
  ctx.save();
  ctx.translate((x0 + x1) / 2, (y0 + y1) / 2);
  ctx.rotate((-rotate * Math.PI) / 180);
  if (rotate % 180) [w, h] = [h, w];
  ctx.translate(-w / 2, -h / 2);
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  paint(w, h);
  ctx.restore();
}

function text(ctx: SKRSContext2D, s: string, x: number, y: number, size: number, color: string, weight = "bold", align: CanvasTextAlign = "center") {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px Helvetica`;
  ctx.textAlign = align;
  ctx.fillText(s, x, y);
}

async function carton() {
  const file = dir + "cardbox-50x50x120.pdf";
  const { page, layout } = await layoutOf(file);
  if (layout.kind !== "carton") throw new Error("expected a carton");
  const canvas = createCanvas(Math.round(page.width * S), Math.round(page.height * S));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const orange = "#f57c00", deep = "#e65100", cream = "#fff8ee";
  const brand = (w: number, h: number, lang: "en" | "fr") => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, orange);
    g.addColorStop(1, deep);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.arc(w * (0.2 + (i % 3) * 0.35), h * (0.62 + Math.floor(i / 3) * 0.16), w * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }
    text(ctx, "NUTRIVITA", w / 2, h * 0.16, w * 0.17, "#fff");
    text(ctx, "Vitamin C", w / 2, h * 0.3, w * 0.15, cream);
    text(ctx, "500 mg", w / 2, h * 0.4, w * 0.2, "#fff");
    text(ctx, lang === "en" ? "30 chewable tablets" : "30 comprimés à croquer", w / 2, h * 0.48, w * 0.07, cream, "normal");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, h * 0.9, w, h * 0.1);
    text(ctx, "DEMO PRODUCT · NOT FOR SALE", w / 2, h * 0.965, w * 0.055, deep);
  };
  const info = (w: number, h: number, title: string, lines: string[]) => {
    ctx.fillStyle = cream;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = orange;
    ctx.fillRect(0, 0, w, h * 0.09);
    text(ctx, title, w / 2, h * 0.06, w * 0.09, "#fff");
    lines.forEach((l, i) => text(ctx, l, w * 0.08, h * (0.16 + i * 0.05), w * 0.06, "#4e342e", "normal", "left"));
  };

  const painters: Record<FaceName, (w: number, h: number) => void> = {
    front: (w, h) => brand(w, h, "en"),
    back: (w, h) => brand(w, h, "fr"),
    left: (w, h) => info(w, h, "Directions", ["Adults: chew 1 tablet", "daily with food.", "Do not exceed the", "stated dose.", "", "Store below 25 °C", "in a dry place.", "", "Keep out of reach", "of children."]),
    right: (w, h) => info(w, h, "Ingredients", ["Vitamin C 500 mg", "(ascorbic acid)", "Sorbitol, orange", "flavour, citric acid.", "", "Made for this demo", "by packform.", "", "Batch: DEMO-001", "Exp: 12/2099"]),
    top: (w, h) => {
      ctx.fillStyle = orange;
      ctx.fillRect(0, 0, w, h);
      text(ctx, "NUTRIVITA", w / 2, h * 0.45, w * 0.16, "#fff");
      text(ctx, "Vitamin C 500 mg", w / 2, h * 0.68, w * 0.09, cream, "normal");
    },
    bottom: (w, h) => {
      ctx.fillStyle = cream;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = i % 3 ? "#222" : cream;
        ctx.fillRect(w * 0.15 + i * (w * 0.7) / 40, h * 0.3, (w * 0.7) / 60, h * 0.35);
      }
      text(ctx, "0 12345 67890 5", w / 2, h * 0.8, w * 0.08, "#222", "normal");
    },
  };
  // Which panel ends up as which face, and how to turn the artwork so it reads correctly once folded
  const m = panelMatrices(layout);
  const faceOf = (n: number[]): FaceName => {
    const k = [0, 1, 2].reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a));
    return ([["left", "right"], ["bottom", "top"], ["back", "front"]] as const)[k][n[k] > 0 ? 1 : 0];
  };
  const up: Record<FaceName, number[]> = { front: [0, 1, 0], back: [0, 1, 0], left: [0, 1, 0], right: [0, 1, 0], top: [0, 0, -1], bottom: [0, 0, 1] };
  const best = new Map<FaceName, number>();
  layout.panels.forEach((p, i) => {
    const f = faceOf(applyDir(m[i], [0, 0, 1]));
    if (!best.has(f) || layout.panels[best.get(f)!].area < p.area) best.set(f, i);
  });
  for (const [name, i] of best) {
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const pageUp = applyDir(m[i], [0, 1, 0]), pageRight = applyDir(m[i], [1, 0, 0]);
    const want = up[name];
    const rotate = dot(pageUp, want) > 0.5 ? 0 : dot(pageUp, want) < -0.5 ? 180 : dot(pageRight, want) > 0.5 ? 270 : 90;
    panel(ctx, layout.panels[i].bbox, rotate, (w, h) => painters[name](w, h));
  }
  const art = dir + "cardbox-art.png";
  writeFileSync(art, canvas.toBuffer("image/png"));
  const { glb } = await dielineToGlb(file, { art });
  writeFileSync(dir + "cardbox.glb", glb);
}

async function label() {
  const file = dir + "bottle-label-12oz.pdf";
  const { page, layout } = await layoutOf(file);
  if (layout.kind !== "label") throw new Error("expected a label");
  const canvas = createCanvas(Math.round(page.width * S), Math.round(page.height * S));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  panel(ctx, layout.bleed ?? layout.trim, 0, (w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#0277bd");
    g.addColorStop(1, "#01579b");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // waves
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    for (let k = 0; k < 2; k++) {
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 8) ctx.lineTo(x, h * (0.78 + k * 0.08) + Math.sin(x / (w / 9) + k) * h * 0.05);
      ctx.lineTo(w, h);
      ctx.fill();
    }
    text(ctx, "AQUA PURE", w / 2, h * 0.45, h * 0.3, "#fff");
    text(ctx, "NATURAL SPRING WATER", w / 2, h * 0.65, h * 0.1, "#b3e5fc");
    text(ctx, "12 FL OZ (355 mL)", w * 0.12, h * 0.6, h * 0.08, "#e1f5fe", "normal");
    text(ctx, "Demo label · packform", w * 0.88, h * 0.6, h * 0.07, "#e1f5fe", "normal");
  });
  const art = dir + "bottle-label-art.png";
  writeFileSync(art, canvas.toBuffer("image/png"));
  const { glb } = await dielineToGlb(file, { art, container: { height: 190, capColor: "#0277bd" } });
  writeFileSync(dir + "bottle-label.glb", glb);
}

await carton();
await label();
console.log("sample models written to samples/");
