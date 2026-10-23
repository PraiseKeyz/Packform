# packform

**Give packaging its form.**

Turn a packaging **dieline** (`.ai` or `.pdf`) into a textured **3D model** (`.glb`), ready for the web, AR, Blender or any 3D tool.
Cartons become a folded box, and flat labels become a bottle with the label wrapped around it. Comes with a drop-in React viewer.

- **Exact, not AI-guessed.** Shapes are built with geometry at their true size. Faces are the real print artwork.
- **Works with any line colours.** Folds are found by their shape, not their colour, so red, cyan, black-dashed and other conventions all work.
- **Automatic.** No measuring or configuration.
- **Pure Node.js.** No Python, no Illustrator, no GPU.

## Command line

```bash
npx packform medicine_box_50x50x120_mm.ai -o box.glb
```

```
✔ box.glb (526 KB)
  carton 50 × 120 × 50 mm · lines from page 3 · artwork from page 2
```

```bash
npx packform bottle-label-template.pdf --art my-label.png --height 190
```

```
✔ bottle-label-template.glb (233 KB)
  label 178 × 51 mm → bottle · lines from page 1 · artwork from --art file
```

| Option | |
|---|---|
| `-o, --out <file>` | Output `.glb` (default: next to the input) |
| `--art <file>` | Artwork as a PDF or image on the same artboard as the dieline, when it isn't in the dieline file itself |
| `--kind carton\|label` | Skip auto-detection |
| `--dpi <n>` | Texture resolution (default `300`) |
| `--texture <file>` | Also save the texture image |
| `--json` | Print what was detected |
| **Cartons** | |
| `--size <WxHxD>` | Box size in mm, e.g. `50x120x50` (default: measured) |
| `--front <1-4>` | Which wall, counting left to right on the flat layout, is the front |
| `--lines-page <n>` / `--art-page <n>` | Pick pages by hand (default: automatic) |
| **Labels / bottles** | |
| `--diameter <mm>` | Bottle diameter (default: label width ÷ π, so the label wraps once around) |
| `--height <mm>` | Bottle height including the cap (default: 3 × diameter) |
| `--cap <#rrggbb>` | Cap colour |
| `--opaque` | Opaque body instead of clear plastic |

## In code

```ts
import { writeFile } from "node:fs/promises";
import { dielineToGlb } from "packform";

const { glb, layout } = await dielineToGlb("medicine_box.ai");
await writeFile("box.glb", glb);
console.log(layout.kind, layout.size); // "carton" { width: 50, height: 120, depth: 50 }

const bottle = await dielineToGlb("label.pdf", { art: "label-art.png", bottle: { diameter: 65, height: 210 } });
```

Lower-level pieces are exported too: `openPdf`, `readPage`, `lineStyles`, `detectBox`, `detectLabel`, `detectDieline`,
`renderRegion`, `buildBoxGlb` (wrap any six images onto a box) and `buildBottleGlb` (wrap any image around a bottle).

## React viewer

```bash
npm install packform three @react-three/fiber @react-three/drei
```

```tsx
"use client";
import { BoxViewer } from "packform/react";

export default function Product() {
  return <BoxViewer src="/models/box.glb" style={{ height: 500 }} />;
}
```

Props: `src`, `autoRotate` (default `true`), `zoom` (`true`), `shadow` (`true`), `background`, `className`, `style`.
It works for bottles too. In Next.js, import it in a client component.

## How it works

1. **Read the PDF** (`.ai` files are PDFs inside) with pdf.js: every stroked line, with its colour, width and whether it's dashed.
2. **Group lines by style.** A dieline uses one style per job (cut, fold, bleed, safe area), but every tool picks different colours:

   | Source | Folds | Cuts |
   |---|---|---|
   | Pacdora | red | dark blue |
   | Templatemaker | thin cyan | thick crimson |
   | Many printers | dashed | solid |
   | Label printers | (none) | red, with a green bleed |

3. **Find a carton by shape.** Each style is tried as "the folds". The right one has 3 or more long parallel lines of equal height,
   with walls whose opposite sides match. Cut lines never fit, whatever their colour. Dashed styles are tried first.
   On a tuck-end carton the top lid hangs from the back wall, so the front is two walls over. The walls wrap
   front → right → back → left, and lids are rotated so they read correctly once folded.
4. **Otherwise, find a label:** nested rectangles. The outer one is the bleed, the next one in is the trim (the cut size).
5. **Render the artwork** for each face at 300 dpi, from the dieline file or from `--art`.
6. **Build the model** in metres: a box with a texture atlas, or a bottle (body, shoulder, neck, cap) made by spinning a profile,
   with the label on a band just outside the body. Then write it as binary glTF.

## Supported dielines

- **Tuck-end cartons** (reverse and straight tuck): four walls in a row, a glue flap, and a lid top and bottom.
- **Wrap-around labels** for bottles, jars and cans: a rectangle (rounded corners are fine), with or without bleed and safe area.

Not yet: other carton styles (crash-lock bottoms, sleeves, trays), tapered or shaped bottles, fold animation. See the roadmap.

## Notes

- **Colours:** print artwork is often CMYK. Like every PDF viewer, the tool converts it to screen RGB, so shades can differ slightly from Illustrator.
- **Hidden faces:** dust flaps and the glue flap end up inside the box, so they are not rendered.
- **Bottle height:** a label template doesn't say how tall the bottle is. Pass `--height` (and `--diameter` if the label doesn't wrap all the way round).

## Roadmap

- [ ] Fold / unfold animation (export hinged panels, plus a `<BoxViewer fold>` slider)
- [ ] Built-in Draco + WebP compression
- [ ] More carton styles (crash-lock, sleeve, tray)
- [ ] Bottle shape presets (water, pharma amber, jar, can) and tapered labels (cone templates)
- [ ] Blister packs and sachets (flat slabs, front and back)
- [ ] Read spot-colour and layer names ("Cut", "Crease") as extra hints
- [ ] ICC colour management for CMYK artwork

## Development

```bash
npm install
npm test                          # tests use fixtures/, generated from scratch by the script below
npx tsx scripts/make-fixtures.ts  # regenerate the test dielines (red, cyan, dashed folds; bottle label)
npm run build                     # dist/ (CLI, library, React entry)
```

Put real-world templates in `samples/` to test against them locally. That folder is ignored by git and npm, because most
template licences don't allow redistribution. `scripts/sample-art.ts` paints demo artwork onto the two samples used during development.

## Licence

MIT
