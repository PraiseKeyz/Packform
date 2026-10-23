#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { dielineToGlb } from "./index";

const HELP = `
packform: give packaging its form. Turns a packaging dieline (.ai / .pdf) into a textured 3D model (.glb)

Cartons become a folded box; flat labels become a bottle with the label wrapped around it.

Usage
  packform <dieline.ai|pdf> [options]

Options
  -o, --out <file>        Output .glb (default: next to the input, same name)
      --art <file>        Artwork (PDF or image) on the same artboard as the dieline, if it isn't in the dieline file
      --kind <type>       carton | label (default: auto)
      --dpi <n>           Texture resolution (default: 300)
      --texture <file>    Also save the texture image (JPEG)
      --json              Print what was detected as JSON

Cartons
      --size <WxHxD>      Box size in mm, e.g. 50x120x50 (default: measured from the dieline)
      --front <1-4>       Which wall, counting left to right on the flat layout, is the front
      --lines-page <n>    Page number (1-based) with the dieline lines (default: auto)
      --art-page <n>      Page number (1-based) with the artwork (default: auto)

Labels / bottles
      --diameter <mm>     Bottle diameter (default: label width ÷ π, so the label wraps once around)
      --height <mm>       Bottle height including the cap (default: 3 × diameter)
      --cap <#rrggbb>     Cap colour (default: #1f5fbf)
      --opaque            Make the bottle body opaque instead of clear plastic

  -h, --help              Show this help

Examples
  npx packform medicine_box_50x50x120_mm.ai -o box.glb
  npx packform bottle-label.pdf --art label-design.png --diameter 65 --height 210
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      art: { type: "string" },
      kind: { type: "string" },
      size: { type: "string" },
      dpi: { type: "string" },
      front: { type: "string" },
      "lines-page": { type: "string" },
      "art-page": { type: "string" },
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

  let size;
  if (values.size) {
    const m = values.size.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i);
    if (!m) throw new Error(`--size must look like 50x120x50 (width x height x depth, in mm)`);
    size = { width: +m[1], height: +m[2], depth: +m[3] };
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
  if (values.kind && values.kind !== "carton" && values.kind !== "label") throw new Error(`--kind must be carton or label`);
  if (values.cap && !/^#?[0-9a-f]{6}$/i.test(values.cap)) throw new Error(`--cap must be a colour like #1f5fbf`);

  const out = values.out ?? path.join(path.dirname(input), path.basename(input, path.extname(input)) + ".glb");
  const result = await dielineToGlb(input, {
    kind: values.kind as "carton" | "label" | undefined,
    art: values.art,
    size,
    dpi: int(values.dpi, "--dpi"),
    front: int(values.front, "--front"),
    linesPage: values["lines-page"] ? int(values["lines-page"], "--lines-page")! - 1 : undefined,
    artPage: values["art-page"] ? int(values["art-page"], "--art-page")! - 1 : undefined,
    bottle: {
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
    console.log(JSON.stringify({ output: out, artPage: result.artPage + 1 || null, ...layout, linesPage: layout.linesPage + 1 }, null, 2));
  } else if (layout.kind === "carton") {
    const { width, height, depth } = layout.size;
    console.log(`✔ ${out} (${(result.glb.byteLength / 1024).toFixed(0)} KB)`);
    console.log(`  carton ${width} × ${height} × ${depth} mm · lines from page ${layout.linesPage + 1} · artwork from ${artFrom}`);
  } else {
    console.log(`✔ ${out} (${(result.glb.byteLength / 1024).toFixed(0)} KB)`);
    console.log(`  label ${layout.size.width} × ${layout.size.height} mm → bottle · lines from page ${layout.linesPage + 1} · artwork from ${artFrom}`);
  }
}

main().catch((err) => {
  console.error(`✖ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
