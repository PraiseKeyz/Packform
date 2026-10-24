# Changelog

All notable changes to packform. This project follows [Semantic Versioning](https://semver.org).

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
