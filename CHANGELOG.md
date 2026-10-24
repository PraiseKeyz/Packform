# Changelog

All notable changes to packform. This project follows [Semantic Versioning](https://semver.org).

## 0.2.0

### Added
- **Project workflow for frontend apps.**
  - `packform init` detects the framework's public folder (`public/`, or `static/` for SvelteKit and Gatsby), creates `dielines/` and
    `<public>/packform/`, git-ignores `dielines/`, writes `packform.config.json` and adds a `packform` npm script. Idempotent.
  - `packform build` converts every dieline in `dielines/` into `<public>/packform/<name>.glb` and writes `manifest.json`. It's
    incremental (content hash of dieline + artwork + options), removes outputs whose dieline was deleted, and keeps going past failures.
  - `packform watch` rebuilds on changes in `dielines/` or the config, and waits for files to finish copying.
  - Separate artwork by convention: `<name>.art.png` / `.jpg` / `.webp` / `.pdf` next to the dieline.
  - Per-file options and defaults in `packform.config.json`.
- Programmatic API for the above: `initProject`, `buildProject`, `watchProject`, `detectFramework`, `loadConfig`, `modelName`, `artFor`.

## 0.1.2

### Fixed
- `engines.node` now says `>=22.13`, which `pdfjs-dist` 5 needs. 0.1.x claimed `>=20` and could fail at runtime on Node 20.

### Changed
- README rewritten as a developer reference: API signatures and layout types, output format spec (scene graph, units, axes,
  animation channels), CLI flag table, pipeline overview.
- npm description, plus `repository`, `homepage` and `bugs` links.

### Added
- CI on GitHub Actions: typecheck, tests, build and a CLI smoke test on Node 22, 24 and 26 (Linux and macOS).
- This changelog.

## 0.1.1

### Fixed
- `bin` uses npm's normalised path (`dist/cli.js`), so publishing no longer prints a misleading "invalid and removed" warning.
  The `packform` command was never affected.

## 0.1.0

First release.

- Dieline (PDF/AI) → textured glTF 2.0, true to scale.
- Colour-agnostic detection of cartons, wrap labels, cone labels, blisters, sachets and pouches.
- Carton folding from the panel graph (tuck-end, crash-lock, trays, mailers, sleeves), with a baked `fold` animation:
  tucks pre-bend and slide in behind the wall while their lid closes.
- Container profiles for labels: `bottle`, `amber`, `jar`, `can`, `tube`. Frustum cups from cone labels.
- CLI (`packform`), typed Node API (`dielineToGlb` plus building blocks) and React viewer (`packform/react`).
