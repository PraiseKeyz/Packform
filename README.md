# packform

**Give packaging its form.**

Turn a packaging **dieline** (`.ai` or `.pdf`) into a textured **3D model** (`.glb`), ready for the web, AR, Blender or any 3D tool.
Comes with a drop-in React viewer that can fold cartons open and closed.

- **Exact, not AI-guessed.** Shapes are built with geometry at their true size. Every face is the real print artwork.
- **Any line colours.** Folds are found by their shape, not their colour: red, cyan, black dashed and other conventions all work.
- **Automatic.** It works out what kind of packaging the file is, which page holds the lines and which holds the artwork.
- **Pure Node.js.** No Python, no Illustrator, no GPU.

## What it builds

| Dieline | 3D model |
|---|---|
| **Folding cartons**: tuck-end, crash-lock bottom, trays, mailer boxes, sleeves, lids | Folded from its panels, **with a fold animation** from flat to closed |
| **Wrap-around labels** | A water bottle, amber pharmacy bottle, jar, drinks can or squeeze tube (`--shape`) |
| **Curved (cone) labels** | A tapered cup or tub |
| **Blister cards** | Printed card or foil, clear domes and tablets or capsules |
| **Sachets** | A puffed pillow with sealed edges, front and back artwork |
| **Stand-up pouches** | Front and back with a bottom gusset to stand on |

## Command line

```bash
npx packform carton.ai -o carton.glb
```

```
✔ carton.glb (526 KB)
  carton 50 × 120 × 50 mm · 13 panels · folds in 4 steps · lines from page 3 · artwork from page 2
```

```bash
npx packform label.pdf --shape amber --art label-design.png
npx packform cup-label.pdf
npx packform sachet.pdf --kind sachet
```

| Option | |
|---|---|
| `-o, --out <file>` | Output `.glb` (default: next to the input) |
| `--art <file>` | Artwork as a PDF or image on the same artboard as the dieline, when it isn't in the dieline file itself |
| `--kind <type>` | `carton`, `label`, `cone-label`, `blister`, `sachet` or `pouch` (default: auto) |
| `--dpi <n>` | Texture resolution (default `300`, lowered automatically to keep textures within 4096 px) |
| `--texture <file>` | Also save the texture image |
| `--json` | Print what was detected |
| `--lines-page <n>` / `--art-page <n>` | Pick pages by hand (default: automatic) |
| **Cartons** | |
| `--fold-angle <deg>` | Fold angle for every fold (default `90`) |
| `--no-animation` | Leave out the fold animation |
| **Labels** | |
| `--shape <name>` | `bottle`, `amber`, `jar`, `can` or `tube` (default `bottle`) |
| `--diameter <mm>` | Container diameter (default: label width ÷ π, so the label wraps once around) |
| `--height <mm>` | Height including the cap (default depends on the shape) |
| `--cap <#rrggbb>` | Cap or lid colour |
| `--opaque` | Make a clear body opaque |

## In code

```ts
import { writeFile } from "node:fs/promises";
import { dielineToGlb } from "packform";

const { glb, layout } = await dielineToGlb("carton.ai");
await writeFile("carton.glb", glb);
console.log(layout.kind, layout.size); // "carton" { width: 50, height: 120, depth: 50 }

const bottle = await dielineToGlb("label.pdf", { art: "label-art.png", container: { shape: "amber", diameter: 50 } });
```

Lower-level pieces are exported too:
- **Reading:** `openPdf`, `readPage`, `lineStyles`
- **Detecting:** `analyzePanels` (panels and folds), `detectDieline`, `detectCarton`, `detectLabel`, `detectConeLabel`, `detectBlister`, `detectPillow`
- **Folding:** `panelMatrices` (every panel's position at any point of the fold), `panelPoint`, `panelNormal`
- **Building:** `buildCartonGlb`, `buildContainerGlb`, `buildCupGlb`, `buildBlisterGlb`, `buildPillowGlb`

## React viewer

```bash
npm install packform three @react-three/fiber @react-three/drei
```

```tsx
"use client";
import { BoxViewer } from "packform/react";

export default function Product() {
  return <BoxViewer src="/models/carton.glb" foldControls style={{ height: 500 }} />;
}
```

| Prop | |
|---|---|
| `src` | URL of the `.glb` |
| `foldControls` | Show a Flat ↔ Folded slider (cartons) |
| `fold` | Control the fold yourself, from `0` (flat dieline) to `1` (closed box) |
| `playFold` | Play the fold once when the model loads |
| `autoRotate` | Spin slowly (default `true`, paused while unfolded) |
| `zoom`, `shadow`, `background`, `className`, `style` | Display options |

In Next.js, import it in a client component. The viewer works for every model packform makes. The fold props only affect cartons.

## How it works

### Cartons: the folding engine

1. **Read the PDF** (`.ai` files are PDFs inside) with pdf.js: every stroked line and curve, with its colour, width and whether it's dashed.
2. **Find the panels.** All lines are drawn onto a grid, and every enclosed area becomes a panel. Thin rings (like the strip between a bleed
   line and a cut line) and the outside are ignored. Lines that stop short of a corner (common on real dielines) are bridged.
3. **Find the folds without trusting colours.** For each line style, measure how much of it runs straight between two panels.
   The style that joins the most panels is the fold style. Cut lines only ever border one panel, whatever their colour.
   Diagonal folds (the glued corners of crash-lock bottoms) are ignored, so those flaps stay whole.
4. **Build a folding tree.** Panels are joined along their folds, longest folds first, and the main panel is picked: a front wall,
   or a base with walls on all four sides (trays and mailers, which then lie face down).
5. **Fold.** Every panel turns 90° about its fold, away from the printed side, as real board does. Smaller panels sit a fraction of a millimetre
   further inside, so dust flaps tuck under lids instead of flickering through them.
6. **Animate like hands closing a box.** The walls fold first, then the dust flaps (and the rim of a double wall), then the lids.
   Before each lid moves, its tuck is bent to 90°. As the lid swings shut, the tuck bends a little further, so it points
   straight down and slides in behind the wall instead of passing through it. The motion is eased and sampled 30 times a second
   into the `.glb` as a standard glTF animation, so any glTF viewer can play it. `foldAngleAt()` gives any panel's angle at any moment.
7. **Texture.** The artwork page is rendered once, and every panel keeps its own part of it however it moves. The inside of the board is plain.

### Everything else

- **Labels**: nested rectangles. The outer one is the bleed, the next one in is the trim. The label wraps a container made by spinning a
  profile (body, shoulder, neck, cap) for the chosen shape.
- **Cone labels**: two concentric arcs. Their radii and angle give the cup's top and bottom diameters and height exactly (an unrolled cone).
  The wide end goes up when the arcs bow upwards on the sheet.
- **Blisters**: a card with two or more similar small shapes inside it (the cavities). Domes and tablets are shaped to each cavity.
- **Sachets and pouches**: two same-size panels side by side (front and back). A pouch also has a smaller panel folded on below (the gusset).

## Notes

- **Artwork:** many templates are lines only. Pass the design with `--art` (a PDF or image of the same artboard).
- **Colours:** print artwork is often CMYK. Like every PDF viewer, packform converts it to screen RGB, so shades can differ slightly from Illustrator.
- **Tray walls:** when a wall folds up, its bottom edge on the sheet becomes its top edge. Artwork on tray walls is usually printed upside down
  on the dieline for this reason, and packform shows it the way the real box would.
- **Container height:** a label template doesn't say how tall the bottle is. Pass `--height` (and `--diameter` if the label doesn't wrap all the way round).

## Roadmap

- [ ] Shaped panels that need other fold angles (hexagonal and octagonal boxes, gable tops, pillow packs)
- [ ] Built-in Draco + WebP compression
- [ ] Read spot-colour and layer names ("Cut", "Crease") as extra hints
- [ ] Dropper bottles, pump bottles and aerosols
- [ ] Shrink sleeves that follow a bottle's curves
- [ ] ICC colour management for CMYK artwork

## Development

```bash
npm install
npm test                          # tests use fixtures/, generated from scratch by the script below
npx tsx scripts/make-fixtures.ts  # regenerate the test dielines (every packaging type above)
npm run build                     # dist/ (CLI, library, React entry)
```

Put real-world templates in `samples/` to test against them locally. That folder is ignored by git and npm, because most
template licences don't allow redistribution. `scripts/sample-art.ts` paints demo artwork onto local samples.

## Licence

MIT
