# packform

**Give packaging its form.**

Turn a packaging **dieline** (`.ai` or `.pdf`) into a true-size, textured **3D model** (`.glb`) that works on the web, in AR, in Blender
or in any 3D tool. Cartons fold themselves up with a built-in animation. Labels wrap bottles, jars, cans and tubes. Blisters, sachets
and pouches come out puffed and real. A drop-in React viewer is included.

- **Exact, not AI-guessed.** Shapes are built with geometry at their true size, and every face is the real print artwork.
- **Any line colours.** Folds are found by their shape, not their colour: red, cyan, black-dashed and other conventions all work.
- **Automatic.** packform works out what kind of packaging the file is, which page holds the lines and which holds the artwork.
- **Pure Node.js.** No Python, no Illustrator, no GPU.

```bash
npx packform carton.ai -o carton.glb
```

---

## Contents

1. [What it builds](#what-it-builds)
2. [Install](#install)
3. [Quick start](#quick-start)
4. [Preparing your files](#preparing-your-files)
5. [Command line guide](#command-line-guide)
6. [Using it in code](#using-it-in-code)
7. [Showing models on a website (React)](#showing-models-on-a-website-react)
8. [Using the .glb anywhere else](#using-the-glb-anywhere-else)
9. [Recipes](#recipes)
10. [How it works](#how-it-works)
11. [Troubleshooting](#troubleshooting)
12. [Limitations and roadmap](#limitations-and-roadmap)
13. [Development](#development)

---

## What it builds

| Your dieline | The 3D model |
|---|---|
| **Folding cartons**: tuck-end, crash-lock bottom, trays, mailer boxes, sleeves, lids | Folded from its own panels, **with a fold animation** from flat sheet to closed box (tucks bend first and slide inside, like closing a real box) |
| **Wrap-around labels** | A clear water bottle, amber pharmacy bottle, glass jar, drinks can or squeeze tube |
| **Curved (cone) labels** | A tapered cup or tub, at the exact top and bottom diameters |
| **Blister cards** | Printed card or foil, with clear domes and tablets or capsules |
| **Sachets** | A puffed pillow with sealed edges, front and back artwork |
| **Stand-up pouches** | Front and back, with a bottom gusset to stand on |

## Install

packform needs **Node.js 20 or newer**. It installs ready-made binaries for its image and PDF tools on macOS, Windows and Linux, so there is nothing else to set up.

```bash
# use it once, without installing
npx packform your-dieline.ai

# or add it to a project
npm install packform        # or: pnpm add packform / yarn add packform / bun add packform
```

To get the `packform` command everywhere on your machine: `npm install -g packform`.

## Quick start

1. Get a dieline file with your artwork on it (see [Preparing your files](#preparing-your-files)).
2. Run:

   ```bash
   npx packform medicine_box.ai -o medicine_box.glb
   ```

   ```
   ✔ medicine_box.glb (526 KB)
     carton 50 × 120 × 50 mm · 13 panels · folds in 3 steps · lines from page 3 · artwork from page 2
   ```

3. Look at it: drag the `.glb` into any glTF viewer (for example https://gltf-viewer.donmccurdy.com), or show it on your site with the
   [React viewer](#showing-models-on-a-website-react).

## Preparing your files

### Dieline and artwork

- **The dieline** is the flat template: the lines that say where the packaging is **cut** and **folded**. It decides the **shape**.
- **The artwork** is the design: colours, logo and text. It decides what the model **looks like**.

They often come together in one file, with the design placed on the dieline, but not always:

| You have | What to run | Result |
|---|---|---|
| One file: lines and design together | `packform box.ai` | Full colour model |
| Two files: lines in one, design in another | `packform box.ai --art design.png` (or `--art design.pdf`) | Full colour model |
| Lines only | `packform box.ai` | Correct shape, plain white |

`--art` must be laid out on the **same artboard** as the dieline (the usual way designers work: the design sits over the template).
It can be a PDF or an image (PNG, JPEG, WebP…), and it is scaled to the dieline's page.

### What packform expects in the file

- **A PDF**, or an Illustrator `.ai` saved with *Create PDF Compatible File* switched on (Illustrator's default).
- **Cut and fold lines drawn as strokes** (normal lines), not converted to filled outlines.
- **One style per job.** For example all folds in one colour, or dashed, and all cuts in another. Which colours you use doesn't matter.
- For multi-page files, packform picks the page with the lines and the page with the artwork by itself. Override with `--lines-page` and `--art-page`.

### Labels, cups, blisters, sachets and pouches

- **Label**: the cut rectangle, ideally with the bleed rectangle around it. Rounded corners are fine. Tell packform the container
  with `--shape`, and its `--height` (a label doesn't say how tall the bottle is).
- **Cone label** (cups, tubs): the curved cut shape: two arcs joined by two straight ends.
- **Blister**: the card or foil outline, with every cavity (pocket) drawn inside it.
- **Sachet**: front and back panels side by side. A single panel works too with `--kind sachet`.
- **Pouch**: front and back side by side, each with half of the bottom gusset joined to it by a fold line.

## Command line guide

```bash
packform <dieline.ai|pdf> [options]
```

### Options

| Option | What it does |
|---|---|
| `-o, --out <file>` | Where to save the `.glb` (default: next to the input, same name) |
| `--art <file>` | Separate artwork file (PDF or image) on the same artboard as the dieline |
| `--kind <type>` | Say what it is when auto-detection guesses wrong: `carton`, `label`, `cone-label`, `blister`, `sachet` or `pouch` |
| `--dpi <n>` | Texture sharpness (default `300`, lowered automatically so textures stay within 4096 px) |
| `--texture <file>` | Also save the texture image (JPEG) |
| `--json` | Print everything that was detected, as JSON |
| `--lines-page <n>` | Page number (1-based) with the dieline lines |
| `--art-page <n>` | Page number (1-based) with the artwork |
| **Cartons** | |
| `--fold-angle <deg>` | Fold angle for every fold (default `90`) |
| `--no-animation` | Leave out the fold animation |
| **Labels** | |
| `--shape <name>` | `bottle` (default), `amber`, `jar`, `can` or `tube` |
| `--diameter <mm>` | Container diameter (default: label width ÷ π, so the label wraps exactly once around) |
| `--height <mm>` | Container height including the cap (default depends on the shape) |
| `--cap <#rrggbb>` | Cap or lid colour |
| `--opaque` | Make a clear body (water bottle, jar) opaque |
| `-h, --help` | Show help |

### Examples

```bash
# a carton, with the artwork in the same file
packform carton.ai -o carton.glb

# a line-only template, with the design in a separate PNG
packform template.pdf --art my-design.png -o box.glb

# a 60 ml amber medicine bottle, 50 mm across and 105 mm tall, with a white cap
packform label.pdf --shape amber --diameter 50 --height 105 --cap "#ffffff"

# a drinks can and a squeeze tube from the same label
packform label.pdf --shape can -o can.glb
packform label.pdf --shape tube --diameter 40 -o tube.glb

# a paper cup from a curved label
packform cup-label.pdf

# force a single rectangle to be a sachet, not a label
packform sachet.pdf --kind sachet

# a sharper texture, saved separately too
packform carton.ai --dpi 450 --texture carton-texture.jpg
```

### `--json` output

`--json` prints what packform detected. Sizes are in **millimetres**. Positions (`polygon`, `bbox`, `trim`…) are in **PDF points**
(1/72 inch) on the sheet, measured from the top-left corner. Every kind has `kind`, `size`, `linesPage` and `artPage`. A carton also lists its panels:

```jsonc
{
  "output": "carton.glb",
  "artPage": 2,
  "kind": "carton",
  "size": { "width": 50, "height": 120, "depth": 50 },
  "panels": [
    {
      "id": 1,
      "polygon": [[261, 57], [346, 57], …],   // outline on the flat sheet
      "area": 21639.5, "bbox": [261, 57, 346, 312], "centroid": [303, 184],
      "parent": 0,                              // the panel it folds onto (-1 = the main panel)
      "hinge": { "p1": [346, 57], "p2": [346, 311] },  // the fold line it turns around
      "angle": 1.5708,                          // fold angle in radians
      "stage": 0,                               // when it folds in the animation (0 = first)
      "motion": "fold"                          // fold | lid | tuck | lid-flap
    }
  ],
  "root": 0,                                    // the main panel (front wall, or base)
  "orientation": "standing",                    // or "base-down" for trays and mailers
  "foldStyle": { "color": [0, 171, 237], "width": 0.75, "dashed": false },
  "bbox": [57, 57, 601, 312],                   // the part of the sheet the artwork covers
  "duration": 3,                                // fold animation length in seconds
  "linesPage": 1
}
```

Other kinds: `label` has `trim` (cut size) and `bleed`; `cone-label` has the arc `center`, radii `r1`/`r2` and angles; `blister` has
`card` and `cavities`; `sachet` and `pouch` have `front`, `back` and `gusset`.

Uses: check files automatically before printing or uploading ("is this box really 50 × 120 × 50 mm?"), fill product records with real
sizes, build your own viewers from the panel and fold data, or find out what went wrong when a model looks off.

## Using it in code

### `dielineToGlb(input, options?)`

```ts
import { writeFile } from "node:fs/promises";
import { dielineToGlb } from "packform";

const { glb, layout, texture } = await dielineToGlb("carton.ai");
await writeFile("carton.glb", glb);

console.log(layout.kind);  // "carton"
console.log(layout.size);  // { width: 50, height: 120, depth: 50 }
```

`input` is a file path or the file's bytes (`Uint8Array` or `Buffer`), so it works with uploads too.

| Option | Type | |
|---|---|---|
| `art` | `string \| Uint8Array` | Separate artwork (PDF or image) on the same artboard |
| `kind` | `"carton" \| "label" \| "cone-label" \| "blister" \| "sachet" \| "pouch"` | Skip auto-detection |
| `dpi` | `number` | Texture resolution, default `300` |
| `quality` | `number` | JPEG quality of textures, 1–100, default `90` |
| `linesPage`, `artPage` | `number` | Pages to use, **0-based** |
| `foldAngle` | `number` | Cartons: fold angle in degrees, default `90` |
| `carton` | `{ animation?: boolean; boardColor?: string }` | Cartons: include the fold animation (default `true`); colour of the unprinted inside (default `#ece6da`) |
| `container` | `{ shape?, diameter?, height?, capColor?, bodyColor?, bodyOpacity? }` | Labels: container shape (`bottle`, `amber`, `jar`, `can`, `tube`) and size in mm, colours as `#rrggbb`, opacity 0–1 |

It returns:

| Field | |
|---|---|
| `glb` | The 3D model as binary glTF (`Uint8Array`). Write it to a `.glb` file or send it in a response. |
| `texture` | The main texture image (JPEG `Buffer`) |
| `layout` | Everything detected (same as `--json`). Check `layout.kind` to see which kind it is. |
| `artPage` | Page (0-based) the artwork came from, or `-1` when `art` was given |

### Building blocks

For your own pipelines, every step is exported:

- **Reading:** `openPdf`, `readPage`, `renderRegion`, `lineStyles`
- **Detecting:** `analyzePanels` (panels and folds), `detectDieline`, `detectCarton`, `detectLabel`, `detectConeLabel`, `detectBlister`, `detectPillow`, `choosePages`
- **Folding:** `panelMatrices(layout, progress)` (every panel's 3D placement at any moment, 0 = flat, 1 = closed), `panelPoint`, `panelNormal`, `foldAngleAt`
- **Building:** `buildCartonGlb`, `buildContainerGlb`, `buildCupGlb`, `buildBlisterGlb`, `buildPillowGlb`, `lathe`

All types are included (TypeScript), and the package is ESM-only (`import`, not `require`).

## Showing models on a website (React)

### 1. Install

```bash
npm install packform three @react-three/fiber @react-three/drei
```

`three`, `@react-three/fiber` and `@react-three/drei` are peer dependencies: you only need them for the viewer.

### 2. Make the models

Convert your dielines once and put the `.glb` files where your site serves static files (for Next.js and Vite, that's `public/`):

```bash
npx packform dielines/astro-box.ai -o public/models/astro-box.glb
```

### 3. Show them

```tsx
"use client";
import { BoxViewer } from "packform/react";

export default function ProductPage() {
  return <BoxViewer src="/models/astro-box.glb" foldControls style={{ height: 520 }} />;
}
```

**Next.js (App Router):** use the viewer in a client component, as above (`packform/react` already starts with `"use client"`).
If your page is server-rendered and you see WebGL errors during the build, load it on the client only:

```tsx
"use client";
import dynamic from "next/dynamic";
const BoxViewer = dynamic(() => import("packform/react").then((m) => m.BoxViewer), { ssr: false });
```

**Vite / Create React App / Remix:** import and use it directly.

### Viewer props

| Prop | Default | |
|---|---|---|
| `src` | (required) | URL of the `.glb` |
| `foldControls` | `false` | Show a Flat ↔ Folded slider under the model (cartons) |
| `fold` | (none) | Control the fold yourself, from `0` (flat sheet) to `1` (closed box) |
| `playFold` | `false` | Play the fold once, from flat to closed, when the model loads |
| `autoRotate` | `true` | Spin slowly (paused while a carton is unfolded) |
| `zoom` | `true` | Allow zooming with scroll or pinch |
| `shadow` | `true` | Soft shadow under the model |
| `background` | transparent | Canvas background colour |
| `className`, `style` | | Size it like any element (default height 480 px) |

The viewer works for every model packform makes. The fold props only affect cartons.

### Drive the fold from your own UI

```tsx
const [fold, setFold] = useState(0);
<BoxViewer src="/models/box.glb" fold={fold} autoRotate={false} />
<input type="range" min={0} max={1} step={0.01} value={fold} onChange={(e) => setFold(+e.target.value)} />
```

Tie it to scrolling for a scroll-driven unboxing effect, or animate it with your favourite animation library.

## Using the .glb anywhere else

The output is a standard glTF 2.0 binary. Every carton includes a **`fold` animation**, which most viewers can play.

**three.js**

```js
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const gltf = await new GLTFLoader().loadAsync("/models/box.glb");
scene.add(gltf.scene);
const mixer = new THREE.AnimationMixer(gltf.scene);
const fold = mixer.clipAction(gltf.animations.find((a) => a.name === "fold"));
fold.setLoop(THREE.LoopOnce, 1);
fold.clampWhenFinished = true;
fold.play();
// in your render loop: mixer.update(deltaSeconds)
```

**`<model-viewer>`** (also gives AR on phones):

```html
<script type="module" src="https://unpkg.com/@google/model-viewer@4.0.0/dist/model-viewer.min.js"></script>
<model-viewer src="box.glb" animation-name="fold" autoplay camera-controls ar></model-viewer>
```

**Blender:** *File → Import → glTF 2.0*. The fold animation imports onto the timeline, ready for renders and product videos.

## Recipes

**Convert a whole folder of dielines**

```ts
import { readdir, writeFile } from "node:fs/promises";
import { dielineToGlb } from "packform";

for (const file of await readdir("dielines")) {
  if (!/\.(ai|pdf)$/i.test(file)) continue;
  const { glb, layout } = await dielineToGlb(`dielines/${file}`);
  await writeFile(`models/${file.replace(/\.\w+$/, ".glb")}`, glb);
  console.log(file, layout.kind, layout.size);
}
```

**Convert uploads in an API (Next.js route handler)**

```ts
// app/api/dieline/route.ts
import { dielineToGlb } from "packform";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const file = (await req.formData()).get("dieline") as File;
  const { glb } = await dielineToGlb(new Uint8Array(await file.arrayBuffer()));
  return new Response(glb, { headers: { "content-type": "model/gltf-binary" } });
}
```

In `next.config.js`, keep packform's native tools out of the bundle:
`serverExternalPackages: ["packform", "pdfjs-dist", "@napi-rs/canvas", "sharp"]`.

**Check a file before printing**

```ts
const { layout } = await dielineToGlb("order-1234.ai");
if (layout.kind !== "carton") throw new Error(`Expected a carton, got a ${layout.kind}`);
if (layout.size.height !== 120) throw new Error(`Box is ${layout.size.height} mm tall, expected 120`);
```

**Make files smaller for the web**

```bash
npx @gltf-transform/cli optimize box.glb box.min.glb --texture-compress webp
```

## How it works

### Cartons: the folding engine

1. **Read the PDF** (`.ai` files are PDFs inside) with pdf.js: every stroked line and curve, with its colour, width and whether it's dashed.
2. **Find the panels.** All lines are drawn onto a grid, and every enclosed area becomes a panel. Thin rings (such as the strip between a bleed
   line and a cut line) and the outside are ignored. Lines that stop just short of a corner (common on real dielines) are bridged.
3. **Find the folds without trusting colours.** For each line style, packform measures how much of it runs straight between two panels.
   The style that joins the most panels is the fold style. Cut lines only ever border one panel, whatever their colour.
   Diagonal folds (the glued corners of crash-lock bottoms) are ignored, so those flaps stay whole.
4. **Build a folding tree.** Panels are joined along their folds, longest folds first, and the main panel is picked: a front wall,
   or a base with walls on all four sides (trays and mailers, which then lie face down).
5. **Fold.** Every panel turns 90° about its fold, away from the printed side, as real board does. Smaller panels sit a fraction of a
   millimetre further inside, so dust flaps tuck under lids instead of flickering through them.
6. **Animate like hands closing a box.** The walls fold first, then the dust flaps (and the rim of a double wall), then the lids.
   Before each lid moves, its tuck is bent to 90°. As the lid swings shut, the tuck bends a little further, so it points straight down and
   slides in behind the wall instead of passing through it. The motion is eased and sampled 30 times a second into the `.glb`
   as a standard glTF animation.
7. **Texture.** The artwork page is rendered once, and every panel keeps its own part of it however it moves. The inside of the board is plain.

### Everything else

- **Labels:** nested rectangles. The outer one is the bleed, the next one in is the trim. The label wraps a container made by spinning a
  profile (body, shoulder, neck, cap) for the chosen shape.
- **Cone labels:** two concentric arcs. Their radii and angle give the cup's top and bottom diameters and its height exactly (an unrolled cone).
  The wide end goes up when the arcs bow upwards on the sheet.
- **Blisters:** a card with two or more similar small shapes inside it (the cavities). Domes and tablets are shaped to each cavity.
- **Sachets and pouches:** two same-size panels side by side (front and back). A pouch also has a smaller panel folded on below (the gusset).

## Troubleshooting

| Problem | Fix |
|---|---|
| `Couldn't recognise this dieline` | Say what it is: `--kind carton` (or `label`, `blister`…). The message lists what each check found. |
| The model is plain white | The file has lines only. Add the design with `--art design.png`. |
| It used the wrong page | Choose pages with `--lines-page 3 --art-page 2`. |
| A single rectangle became a bottle, not a sachet | Use `--kind sachet`. |
| The bottle is the wrong size | Set `--diameter` and `--height` in mm. |
| Colours look slightly different from Illustrator | Print artwork is usually CMYK, and every PDF viewer converts it to screen colours a little differently. |
| Tray walls look upside down | That's how the real tray will look: a wall's bottom edge on the sheet becomes its top once folded up, so tray artwork is usually printed upside down on the dieline. |
| The file is too big for the web | Lower `--dpi` (for example 200), or compress it as shown in [Recipes](#recipes). |
| Folds aren't found | Check that cut and fold lines are strokes (not outlined shapes), and that folds share one line style. |

## Limitations and roadmap

packform folds cartons whose folds are straight and close at 90° (tuck-end, crash-lock, trays, mailers, sleeves, lids).
Planned next:

- [ ] Shaped boxes that need other angles (hexagonal and octagonal boxes, gable tops, pillow packs)
- [ ] Built-in Draco + WebP compression
- [ ] Spot-colour and layer names ("Cut", "Crease") as extra hints
- [ ] Dropper bottles, pump bottles and aerosols
- [ ] Shrink sleeves that follow a bottle's curves
- [ ] ICC colour management for CMYK artwork

## Development

```bash
npm install
npm test                          # tests run on fixtures/, generated from scratch by the script below
npx tsx scripts/make-fixtures.ts  # regenerate the test dielines (every packaging type above)
npm run build                     # dist/: CLI, library and React entry
```

Put real-world templates in `samples/` to test against them locally. That folder is ignored by git and npm, because most template
licences don't allow redistribution. `scripts/sample-art.ts` paints demo artwork onto local samples.

## Licence

MIT © Praise Adebayo
