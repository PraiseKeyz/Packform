# packform

[![npm](https://img.shields.io/npm/v/packform?color=cb3837&logo=npm)](https://www.npmjs.com/package/packform)
[![CI](https://github.com/PraiseKeyz/Packform/actions/workflows/ci.yml/badge.svg)](https://github.com/PraiseKeyz/Packform/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/packform)](https://www.npmjs.com/package/packform)
[![node](https://img.shields.io/node/v/packform)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/packform)](./LICENSE)

Dieline (`.pdf` / `.ai`) → true-scale, textured **glTF 2.0** (`.glb`).

packform parses the vector paths of a packaging dieline, classifies it (carton, wrap label, cone label, blister, sachet, pouch),
reconstructs the geometry, and bakes the print artwork into a single `.glb`. Cartons are folded from their panel graph and ship with a
keyframed `fold` animation. CLI, typed Node API, and a React Three Fiber viewer.

```bash
npm i packform
npx packform init        # dielines/ (git-ignored) → public/packform/, config, npm script
npx packform watch       # drop .ai / .pdf files into dielines/, get public/packform/<name>.glb
```

```tsx
<BoxViewer src="/packform/carton.glb" foldControls />   // from "packform/react"
```

Or programmatically:

```ts
import { writeFile } from "node:fs/promises";
import { dielineToGlb } from "packform";

const { glb, layout } = await dielineToGlb("carton.pdf");
await writeFile("carton.glb", glb);

layout.kind; // "carton"
layout.size; // { width: 50, height: 120, depth: 50 }  (mm)
```

- **Colour-agnostic fold detection.** Folds are inferred from topology (line styles that separate panels along straight edges), not from red/dashed conventions.
- **Panel graph folding.** Maximum spanning tree over hinges, root-panel selection, 90° folds away from the print side, z-offset layering for overlapping flaps.
- **Baked animation.** Per-panel rotation channels sampled at 30 fps; tucks pre-bend and are kept inside the carton while lids close.
- **No native toolchain.** pdf.js + `@napi-rs/canvas` + sharp, all with prebuilt binaries. No Python, Illustrator or GPU.
- **ESM, fully typed,** Node ≥ 22.13.

---

- [Project workflow](#project-workflow)
- [Supported inputs](#supported-inputs)
- [CLI](#cli)
- [API](#api)
- [Output format](#output-format)
- [React viewer](#react-viewer)
- [Consuming the .glb elsewhere](#consuming-the-glb-elsewhere)
- [Recipes](#recipes)
- [Pipeline](#pipeline)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Contributing](#contributing)

## Project workflow

For frontend apps, packform manages a source folder and an output folder inside your static files:

```
dielines/                       ← your .ai / .pdf sources (git-ignored, never served)
  carton.ai
  carton.art.png                ← optional separate artwork for carton.ai
  water-label.pdf
public/packform/                ← generated, committed, served at /packform/*
  carton.glb
  water-label.glb
  manifest.json
packform.config.json
```

| Command | |
|---|---|
| `packform init` | Detects the framework's public folder, creates `dielines/` and `<public>/packform/`, appends `/dielines/` to `.gitignore`, writes `packform.config.json`, adds `"packform": "packform build"` to `package.json`. Idempotent; never overwrites. |
| `packform build [--force]` | Converts every dieline in `dielines/` to `<public>/packform/<name>.glb` and writes `manifest.json`. Incremental: skips files whose dieline, artwork and options hash is unchanged. Removes outputs whose dieline was deleted (only files it created). Exits `1` if any file fails; the rest still build. |
| `packform watch` | `build`, then rebuilds on any change in `dielines/` or `packform.config.json`. Waits for files to finish copying before reading them. |

**Public folder by framework**

| Framework | Output |
|---|---|
| Next.js, Vite, Remix, Nuxt, Astro, Angular, Create React App | `public/packform/` |
| SvelteKit, Gatsby | `static/packform/` |
| Other | `public/packform/` (change `output` in the config) |

**Conventions**

- Model name = dieline file name, made URL-safe: `Medicine Box 50×50.ai` → `medicine-box-50x50.glb`.
- Separate artwork: `<name>.art.png` (or `.jpg`, `.jpeg`, `.webp`, `.pdf`) next to `<name>.ai` / `<name>.pdf`.
- Commit `public/packform/`. The dielines stay on your machine: they're only needed to generate the models.
- The build cache lives in `dielines/.packform-cache.json` (ignored along with the folder).

**`packform.config.json`**

```jsonc
{
  "input": "dielines",
  "output": "public/packform",
  "defaults": { "dpi": 300 },                        // applied to every file
  "files": {                                         // per-file overrides, keyed by file name
    "water-label.pdf": { "shape": "amber", "diameter": 50, "height": 105 },
    "sachet.pdf": { "kind": "sachet" }
  }
}
```

Options: `kind`, `dpi`, `quality`, `linesPage`, `artPage` (1-based), `foldAngle`, `animation`, `boardColor`, `shape`, `diameter`,
`height`, `capColor`, `bodyColor`, `bodyOpacity`.

**`manifest.json`**

```json
{
  "generator": "packform@0.2.0",
  "models": {
    "carton": { "file": "carton.glb", "url": "/packform/carton.glb", "source": "carton.ai", "art": "carton.art.png",
                "kind": "carton", "size": { "width": 50, "height": 120, "depth": 50 } }
  }
}
```

Use it to list products without hard-coding paths:

```tsx
import manifest from "../public/packform/manifest.json";
Object.entries(manifest.models).map(([name, m]) => <BoxViewer key={name} src={m.url} />);
```

## Supported inputs

| `kind` | Detected from | Output |
|---|---|---|
| `carton` | ≥ 5 panels joined by straight folds (tuck-end, crash-lock, tray, mailer, sleeve, lid) | Folded carton, node-per-panel hierarchy, `fold` animation |
| `label` | Nested axis-aligned rectangles (bleed ⊃ trim ⊃ safe) | Lathed container: `bottle`, `amber`, `jar`, `can`, `tube` |
| `cone-label` | Two concentric arcs in one line style (annular sector) | Frustum cup, exact top/bottom radii from the unrolled cone |
| `blister` | Card outline containing ≥ 2 similar closed shapes | Card + PVC domes + tablets/capsules per cavity |
| `sachet` | Two equal panels side by side (or one, with `kind: "sachet"`) | Puffed pillow, front/back textures |
| `pouch` | Front/back panels with a hinged gusset panel below | Stand-up pouch with gusset base |

**Input requirements**

- PDF, or Illustrator `.ai` saved with *Create PDF Compatible File* (the default).
- Cut/fold lines as **stroked paths** (not outlined fills), one line style per role. Colours, widths and dash patterns are arbitrary.
- Artwork either on the same PDF (any page; auto-selected) or as a separate PDF/raster on the same artboard (`art` option).
- Multi-page files are supported: the lines page and artwork page are picked automatically (override with `linesPage` / `artPage`).

## CLI

```
packform init | build [--force] | watch      # project workflow (see above)
packform <input.pdf|ai> [options]            # single file
```

| Flag | Type | Default | |
|---|---|---|---|
| `-o, --out` | path | `<input>.glb` | Output file |
| `--art` | path | | Artwork PDF or image, same artboard as the dieline |
| `--kind` | `carton \| label \| cone-label \| blister \| sachet \| pouch` | auto | Skip classification |
| `--dpi` | int | `300` | Texture resolution (clamped so textures stay ≤ 4096 px) |
| `--texture` | path | | Also write the main texture (JPEG) |
| `--json` | | | Print the detected layout as JSON |
| `--lines-page` / `--art-page` | int (1-based) | auto | Page selection |
| `--fold-angle` | degrees | `90` | Cartons: angle for every fold |
| `--no-animation` | | | Cartons: omit the `fold` animation |
| `--shape` | `bottle \| amber \| jar \| can \| tube` | `bottle` | Labels: container profile |
| `--diameter` | mm | `width / π` | Labels: container diameter (default wraps the label exactly once) |
| `--height` | mm | per shape | Labels: total height incl. cap |
| `--cap` | `#rrggbb` | per shape | Labels: cap colour |
| `--opaque` | | | Labels: opaque body |

Exit code `0` on success, `1` on any error (message on stderr).

```bash
packform carton.ai -o carton.glb
packform template.pdf --art design.png                 # line-only template + separate artwork
packform label.pdf --shape amber --diameter 50 --height 105 --cap "#ffffff"
packform sachet.pdf --kind sachet
packform carton.ai --json | jq '.panels | length'
```

## API

### `dielineToGlb`

```ts
function dielineToGlb(input: string | Uint8Array, options?: DielineOptions): Promise<DielineResult>;

interface DielineOptions {
  kind?: "carton" | "label" | "cone-label" | "blister" | "sachet" | "pouch";
  art?: string | Uint8Array;        // separate artwork (PDF or image), same artboard
  dpi?: number;                     // default 300
  quality?: number;                 // JPEG quality 1–100, default 90
  linesPage?: number;               // 0-based
  artPage?: number;                 // 0-based
  foldAngle?: number;               // cartons, degrees, default 90
  carton?: { animation?: boolean; boardColor?: string };           // default: true, "#ece6da"
  container?: {                                                    // labels
    shape?: "bottle" | "amber" | "jar" | "can" | "tube";
    diameter?: number; height?: number;                            // mm
    capColor?: string; bodyColor?: string; bodyOpacity?: number;
  };
}

interface DielineResult {
  glb: Uint8Array;       // binary glTF 2.0
  texture: Buffer;       // main texture (JPEG)
  layout: DielineLayout; // discriminated on `kind`
  artPage: number;       // 0-based, -1 when `art` was supplied
}
```

`input` accepts a path or bytes (`Buffer` works), so it composes with uploads and object storage.

### Layouts

`DielineLayout` is a union discriminated on `kind`. Sizes are millimetres; geometry is in **PDF points, top-left origin**.

```ts
type DielineLayout = CartonLayout | LabelLayout | ConeLabelLayout | BlisterLayout | PillowLayout;

interface CartonLayout {
  kind: "carton";
  size: { width: number; height: number; depth: number };
  panels: FoldedPanel[];
  root: number;                              // main panel index
  orientation: "standing" | "base-down";     // trays/mailers lie on their base
  foldStyle: { color: [number, number, number]; width: number; dashed: boolean };
  bbox: [x0: number, y0: number, x1: number, y1: number]; // texture extent on the sheet
  duration: number;                          // fold animation length, seconds
  linesPage: number;
}

interface FoldedPanel {
  id: number;
  polygon: [number, number][];
  area: number; bbox: [number, number, number, number]; centroid: [number, number];
  parent: number;                            // -1 for the root
  hinge?: { p1: [number, number]; p2: [number, number] };
  angle: number;                             // signed, radians
  stage: number;                             // animation step (folds over [stage, stage + 1] s)
  motion: "fold" | "lid" | "tuck" | "lid-flap";
  tuck?: { lidDepth: number; depth: number };
}

type Rect = [x0: number, y0: number, x1: number, y1: number];
type Point = [number, number];

interface LabelLayout {
  kind: "label";
  size: { width: number; height: number };
  trim: Rect;
  bleed?: Rect;
  linesPage: number;
}

interface ConeLabelLayout {
  kind: "cone-label";
  center: Point; r1: number; r2: number;     // arc centre and radii (pt)
  a0: number; a1: number;                    // sector angles (rad)
  bbox: Rect;
  size: { outer: number; inner: number; height: number }; // arc lengths and slant height (mm)
  linesPage: number;
}

interface BlisterLayout {
  kind: "blister";
  card: Point[]; cardBox: Rect;
  cavities: { box: Rect; fill: number }[];   // fill ≈ 0.785 ellipse … 1 rectangle
  size: { width: number; height: number };
  linesPage: number;
}

interface PillowLayout {
  kind: "sachet" | "pouch";
  front: Rect; back?: Rect; gusset?: Rect;
  size: { width: number; height: number };
  linesPage: number;
}
```

### Lower-level exports

| Stage | Exports |
|---|---|
| Read | `openPdf(bytes)`, `readPage(page) → PageInfo`, `renderRegion(page, rect, dpi) → PNG`, `lineStyles(segments)` |
| Detect | `analyzePanels(page) → { panels, hinges, foldStyle }`, `detectDieline`, `detectCarton`, `detectLabel`, `detectConeLabel`, `detectBlister`, `detectPillow`, `choosePages` |
| Fold | `panelMatrices(layout, progress = 1) → Mat4[]`, `panelPoint(layout, matrices, panel, pt)`, `panelNormal(matrices, panel)`, `foldAngleAt(layout, panel, t)` |
| Build | `buildCartonGlb`, `buildContainerGlb`, `buildCupGlb`, `buildBlisterGlb`, `buildPillowGlb`, `lathe` |
| Project | `initProject(root)`, `buildProject(root, { force?, log? }) → BuildReport`, `watchProject(root) → { close, idle }`, `detectFramework(root)`, `loadConfig(root)`, `modelName(file)`, `artFor(file, files)` |

`panelMatrices` evaluates the same motion that is baked into the animation, so you can reproduce any frame of the fold off-line
(collision checks, custom renderers, server-side thumbnails).

## Output format

- glTF 2.0 binary, **metres**, **+Y up**, front faces **+Z**, centred on the origin.
- **Cartons:** root node `packform` → one node per panel, nested along the fold tree. Each panel node's origin sits on its hinge and its
  rotation is the folded pose (the default pose is closed). Two primitives per panel: `printed` (textured, print side) and `board`
  (inside colour). Animation `fold`: one `rotation` channel per non-root panel, `LINEAR`, 30 fps, length `layout.duration` seconds.
- **Containers:** meshes `label`, `body`, `cap` (no cap for `can`). The label's horizontal centre faces +Z.
- **Blister:** `card` plus `cavity-<n>` meshes (dome + tablet). **Sachet / pouch:** `sachet` or `pouch`, plus `gusset` for pouches.
- Textures are JPEG, ≤ 4096 px. A carton uses one texture covering `layout.bbox`; UVs are the panels' flat sheet coordinates.

## React viewer

```bash
npm i packform three @react-three/fiber @react-three/drei   # three / r3f / drei are optional peers
```

```tsx
"use client";
import { BoxViewer } from "packform/react";

export function Product() {
  return <BoxViewer src="/models/carton.glb" foldControls style={{ height: 520 }} />;
}
```

```ts
interface BoxViewerProps {
  src: string;
  fold?: number;          // 0 (flat) … 1 (closed); controlled mode
  foldControls?: boolean; // built-in slider (uncontrolled)
  playFold?: boolean;     // play flat → closed once on load
  autoRotate?: boolean;   // default true, paused while unfolded
  zoom?: boolean;         // default true
  shadow?: boolean;       // default true
  background?: string;    // default transparent
  className?: string;
  style?: React.CSSProperties; // default height 480
}
```

`packform/react` ships with a `"use client"` directive. If a server-rendered route complains about WebGL, load it client-only:
`dynamic(() => import("packform/react").then((m) => m.BoxViewer), { ssr: false })`.

Controlled fold, e.g. scroll-driven:

```tsx
const [fold, setFold] = useState(0);
<BoxViewer src="/models/carton.glb" fold={fold} autoRotate={false} />
```

## Consuming the .glb elsewhere

**three.js**

```js
const gltf = await new GLTFLoader().loadAsync("/carton.glb");
const mixer = new THREE.AnimationMixer(gltf.scene);
const fold = mixer.clipAction(THREE.AnimationClip.findByName(gltf.animations, "fold"));
fold.setLoop(THREE.LoopOnce, 1).clampWhenFinished = true;
fold.play(); // mixer.update(dt) in your loop, or set fold.time for scrubbing
```

**`<model-viewer>`**: `<model-viewer src="carton.glb" animation-name="fold" autoplay camera-controls ar></model-viewer>`

**Blender**: *File → Import → glTF 2.0*; the `fold` action lands on the timeline.

## Recipes

**Batch convert**

```ts
for (const f of await readdir("dielines")) {
  if (!/\.(ai|pdf)$/i.test(f)) continue;
  const { glb, layout } = await dielineToGlb(`dielines/${f}`);
  await writeFile(`models/${f.replace(/\.\w+$/, ".glb")}`, glb);
}
```

**HTTP endpoint (Next.js route handler)**

```ts
export const runtime = "nodejs";
export async function POST(req: Request) {
  const file = (await req.formData()).get("dieline") as File;
  const { glb } = await dielineToGlb(new Uint8Array(await file.arrayBuffer()));
  return new Response(glb, { headers: { "content-type": "model/gltf-binary" } });
}
// next.config: serverExternalPackages: ["packform", "pdfjs-dist", "@napi-rs/canvas", "sharp"]
```

**Pre-press validation**

```ts
const { layout } = await dielineToGlb(file);
assert(layout.kind === "carton" && layout.size.height === 120);
```

**Smaller files**: `npx @gltf-transform/cli optimize in.glb out.glb --texture-compress webp`

## Pipeline

1. **Parse.** pdf.js operator lists → stroked segments with CTM-resolved coordinates, colour, width and dash state. Béziers are flattened.
2. **Segment.** Segments are rasterised as barriers (gap-closing extension of straight lines), and flood fill yields regions. Panels are
   enclosed regions passing area and fill-ratio thresholds (which drops the outside and bleed rings).
3. **Find folds.** For every line style, sample both sides of each segment. Length that straight-separates two panels scores toward that
   style. The top-scoring style is the fold style. Diagonal fold segments are excluded so crash-lock flaps stay whole.
4. **Classify.** Carton (≥ 5 hinged panels) → cone label (concentric arc pair, circle fit) → blister → pouch/sachet → label (nested rects).
5. **Fold (cartons).** Maximum spanning tree over hinges by length; root = largest panel without a top hinge (base-down if hinged on four
   sides); sign of each 90° rotation chosen so panels fold away from the print side. Stages: walls → flaps / double-wall rims → lids;
   tucks pre-bend and get extra bend `≈ asin(tuckDepth / lidDepth)` while their lid closes.
6. **Emit.** The artwork is rendered once per region, triangulated with earcut, and written with glTF-Transform.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Couldn't recognise this dieline` | Pass `kind`. The error lists each detector's reason. |
| Untextured (white) model | Line-only file: pass `art`. |
| Wrong page used | `linesPage` / `artPage` (0-based in the API, 1-based in the CLI). |
| Rectangle classified as `label` | Use `kind: "sachet"`. A lone rectangle is ambiguous. |
| No folds found | Lines are outlined fills, or folds don't share one style. |
| Colours differ slightly from Illustrator | CMYK → sRGB conversion (no ICC). |
| Tray artwork upside down | Physically correct: walls fold up about their bottom edge on the sheet. |
| Large files | Lower `dpi`, or post-process with glTF-Transform. |

## Roadmap

- [ ] Non-90° folds: polygonal boxes, gable tops, pillow packs
- [ ] Built-in Draco / WebP / KTX2 compression
- [ ] OCG layer and spot-colour names as detection hints
- [ ] Dropper, pump and aerosol profiles; shrink sleeves
- [ ] ICC-managed CMYK

## Contributing

```bash
git clone https://github.com/PraiseKeyz/Packform && cd Packform
npm install
npm test                          # vitest, generated fixtures only
npm run typecheck && npm run build
npx tsx scripts/make-fixtures.ts  # regenerate fixtures/ (every supported kind)
```

Fixtures are generated from scratch, so they're safe to redistribute. Put third-party templates in `samples/` (git- and npm-ignored);
tests against them run only when present. Issues and PRs: https://github.com/PraiseKeyz/Packform/issues.

## License

MIT © Praise Adebayo · [Changelog](./CHANGELOG.md)
