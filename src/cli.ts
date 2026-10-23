#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { dielineToGlb, type ContainerShape, type DielineKind, type DielineLayout } from "./index";

const KINDS: DielineKind[] = ["carton", "label", "cone-label", "blister", "sachet", "pouch"];
const SHAPES: ContainerShape[] = ["bottle", "amber", "jar", "can", "tube"];

const HELP = `
packform: give packaging its form. Turns a packaging dieline (.ai / .pdf) into a textured 3D model (.glb)

  cartons      fold up from their panels (tuck-end, crash-lock, trays, mailers, sleeves…) with a fold animation
  labels       wrap a bottle, amber pharmacy bottle, jar, can or squeeze tube
  cone labels  wrap a tapered cup or tub
  blisters     card or foil with clear domes and tablets
  sachets      puffed pillow, front and back
  pouches      stand-up pouch with a bottom gusset

Usage
  packform <dieline.ai|pdf> [options]

Options
  -o, --out <file>        Output .glb (default: next to the input, same name)
      --art <file>        Artwork (PDF or image) on the same artboard as the dieline, if it isn't in the dieline file
      --kind <type>       ${KINDS.join(" | ")} (default: auto)
      --dpi <n>           Texture resolution (default: 300)
      --texture <file>    Also save the texture image (JPEG)
      --json              Print what was detected as JSON
      --lines-page <n>    Page number (1-based) with the dieline lines (default: auto)
      --art-page <n>      Page number (1-based) with the artwork (default: auto)

Cartons
      --fold-angle <deg>  Fold angle for every fold (default: 90)
      --no-animation      Leave out the fold animation

Labels
      --shape <name>      ${SHAPES.join(" | ")} (default: bottle)
      --diameter <mm>     Container diameter (default: label width ÷ π, so the label wraps once around)
      --height <mm>       Container height including the cap (default depends on the shape)
      --cap <#rrggbb>     Cap or lid colour
      --opaque            Make a clear body opaque

  -h, --help              Show this help

Examples
  npx packform carton.ai -o carton.glb
  npx packform label.pdf --shape amber --art label-design.png
  npx packform sachet.pdf --kind sachet
`;

function summary(layout: DielineLayout): string {
  switch (layout.kind) {
    case "carton": {
      const { width, height, depth } = layout.size;
      return `carton ${width} × ${height} × ${depth} mm · ${layout.panels.length} panels · folds in ${layout.duration} steps`;
    }
    case "label":
      return `label ${layout.size.width} × ${layout.size.height} mm`;
    case "cone-label":
      return `cone label, arcs ${layout.size.outer} / ${layout.size.inner} mm, ${layout.size.height} mm tall → cup`;
    case "blister":
      return `blister ${layout.size.width} × ${layout.size.height} mm · ${layout.cavities.length} cavities`;
    case "sachet":
    case "pouch":
      return `${layout.kind} ${layout.size.width} × ${layout.size.height} mm${layout.back ? " · front and back" : ""}${layout.gusset ? " · gusset" : ""}`;
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      art: { type: "string" },
      kind: { type: "string" },
      dpi: { type: "string" },
      "lines-page": { type: "string" },
      "art-page": { type: "string" },
      "fold-angle": { type: "string" },
      "no-animation": { type: "boolean" },
      shape: { type: "string" },
      diameter: { type: "string" },
      height: { type: "string" },
      cap: { type: "string" },
      opaque: { type: "boolean" },
      texture: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const input = positionals[0];
  if (values.help || !input) {
    console.log(HELP);
    process.exit(input || values.help ? 0 : 1);
  }

  const int = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
    return n;
  };
  const num = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!(n > 0)) throw new Error(`${name} must be a positive number`);
    return n;
  };
  if (values.kind && !KINDS.includes(values.kind as DielineKind)) throw new Error(`--kind must be one of: ${KINDS.join(", ")}`);
  if (values.shape && !SHAPES.includes(values.shape as ContainerShape)) throw new Error(`--shape must be one of: ${SHAPES.join(", ")}`);
  if (values.cap && !/^#?[0-9a-f]{6}$/i.test(values.cap)) throw new Error(`--cap must be a colour like #1f5fbf`);

  const out = values.out ?? path.join(path.dirname(input), path.basename(input, path.extname(input)) + ".glb");
  const result = await dielineToGlb(input, {
    kind: values.kind as DielineKind | undefined,
    art: values.art,
    dpi: int(values.dpi, "--dpi"),
    linesPage: values["lines-page"] ? int(values["lines-page"], "--lines-page")! - 1 : undefined,
    artPage: values["art-page"] ? int(values["art-page"], "--art-page")! - 1 : undefined,
    foldAngle: num(values["fold-angle"], "--fold-angle"),
    carton: { animation: !values["no-animation"] },
    container: {
      shape: values.shape as ContainerShape | undefined,
      diameter: num(values.diameter, "--diameter"),
      height: num(values.height, "--height"),
      capColor: values.cap ? "#" + values.cap.replace("#", "") : undefined,
      bodyOpacity: values.opaque ? 1 : undefined,
    },
  });

  await writeFile(out, result.glb);
  if (values.texture) await writeFile(values.texture, result.texture);

  const { layout } = result;
  const artFrom = result.artPage < 0 ? "--art file" : `page ${result.artPage + 1}`;
  if (values.json) {
    console.log(JSON.stringify({ output: out, artPage: result.artPage < 0 ? null : result.artPage + 1, ...layout, linesPage: layout.linesPage + 1 }, null, 2));
  } else {
    console.log(`✔ ${out} (${(result.glb.byteLength / 1024).toFixed(0)} KB)`);
    console.log(`  ${summary(layout)} · lines from page ${layout.linesPage + 1} · artwork from ${artFrom}`);
  }
}

main().catch((err) => {
  console.error(`✖ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
