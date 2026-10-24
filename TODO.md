# TODO

Known issues still open after the general folding engine landed.

## Bump the version before the next publish

The folding engine changed the public API, but `package.json` is still at `0.1.0`:

- removed: `DielineOptions.size`, `DielineOptions.front`, `DielineOptions.bottle`, `buildBoxGlb`, `detectBox`, `BoxLayout`, `FaceName`, and the CLI flags `--size` and `--front`
- added: `DielineOptions.container`, `DielineOptions.carton`, `CartonLayout` (a panel tree instead of six faces)

If 0.1.0 was ever published, release this as `0.2.0` with a changelog entry listing the above.

## `frames()` is recomputed per point (`src/fold.ts`)

`panelPoint` calls `frames(layout)` every time, and `foldedBounds` calls `panelPoint` for every polygon point of every panel,
so `frames` runs (points × panels) times. `foldedBounds` itself runs twice (once for `size` in `detectCarton`,
once via `centerOffset` in `buildCartonGlb`). Cheap at today's panel counts, but compute the frames once and pass
them in (or cache them per layout).

## Viewer framing when unfolded (`src/react.tsx`)

`BoxViewer` scales the model from its closed pose. A flat dieline is several times larger than the closed carton, so at
`fold` near 0 it spills past the contact shadow and the camera framing; `maxDistance = 12` only lets users zoom out by hand.
Options: fit the camera to the bounds at the current fold, or scale using the larger of the closed and flat bounds.
