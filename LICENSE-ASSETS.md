# Asset licensing

This repository mixes source code with a large body of generated, baked, and third-party
assets, and they are not all under the same license. Code is MIT (see `LICENSE`); assets carry
the licenses described below, grouped by category.

The machine-readable source of truth for runtime asset provenance is
`terrain/public/assets-manifest.json`, checked by `npm run validate:assets`. Every entry names an
id, title, author, source, license, attribution string, the runtime files it covers, and a
recipe (script or doc) to reproduce it. Where this document and the manifest appear to disagree,
the manifest is authoritative for the files it lists.

Manifest coverage is machine-enforced: `validate:assets` walks every shipped runtime asset file
under `terrain/public/` and fails if any of them lacks a manifest entry or is claimed by more than
one entry. The walk excludes the R2-hosted tile and imagery pyramids, `treepoints.bin`, and the
raw `atlas-candidates/` bake inputs for `veg-atlas.png`, none of which ship in this repository.

Coverage is complete: every shipped runtime asset has an entry. "Shipped" is taken from git — all
tracked files plus anything untracked and not ignored — so a new asset added without a manifest
entry fails the check before it can be committed, and a file type in neither classification list
(a future `.ktx2` or `.hdr`, say) fails rather than being skipped silently.

## Source code — MIT

All `.js`, `.py`, `.mjs`, `.html`, shader, and config source in this repository is MIT-licensed
(see `LICENSE`).

## Project-generated assets — CC0-1.0

Assets authored by this project — rather than sourced from a third party — are dedicated to the
public domain under CC0-1.0. This covers:

- The AI-image-generated albedo textures: the transport two-track/trail tiles
  (`terrain/public/materials/transport/`) and the Moulton barn atlas and front-elevation
  projections (`terrain/public/materials/moulton-barn/`).
- The measured building reconstructions: T. A. Moulton Barn, John Moulton Barn, and the Chapel
  of the Transfiguration (`terrain/public/models/`), built from public-domain federal elevation
  data and NPS/HABS/USGS reference photography.
- The baked rasters derived from public-domain federal data: `ao.png`, `forestmask.png`,
  `groundtint.png`, `horizon_a.png`/`horizon_b.png`, `landcover.png`, `vegheight.png`, and
  `water-surface.png` (all under `terrain/public/`).
- The vegetation photo-billboard atlas (`veg-atlas.png`), a runtime bake composited from five
  CC0-licensed third-party photo cutouts rather than federal data — see "CC0-1.0 third-party
  assets" below for the source-by-source attribution.

These are dedicated rather than licensed because AI-generated images and mechanically baked
derivatives of public-domain source data may not attract copyright in the US in the first place,
so the project dedicates any rights it might hold instead of asserting them.

## US federal public domain

USGS 3DEP DEM, USDA NAIP imagery, NLCD, NHD, Census TIGER, USGS GNIS, and LANDFIRE are US
federal government works and carry no copyright restriction in the US. No obligation attaches to
their use here; source credit is retained in `terrain/pipeline/SOURCES.md` as good practice.

## ODbL-1.0 — attribution required

OpenStreetMap contributors and Microsoft Building Footprints data are licensed ODbL-1.0, which
requires attribution. This is satisfied by the visible in-app credit line (the `#credit` HUD in
`grand-teton-3d.html`) and by the attribution strings embedded in the generated `roads.json` and
`buildings.json`. **Do not remove either of these** without replacing them with an equivalent
ODbL attribution.

`terrain/public/roads.png`, the distance-field bake of `roads.json` produced by
`terrain/pipeline/roads/bake_sdf.py`, is a mechanical derivative of the same OSM way geometry and
carries the same ODbL-1.0 obligation. It is **not** public-domain federal data, and is licensed
ODbL-1.0 in the manifest (`roads-sdf-bake`) rather than being grouped with the federal bakes. The
validator enforces this: any entry licensed ODbL-1.0 or CC-BY-4.0 must name its attribution
obligation in its `attribution` string.

## CC0-1.0 third-party assets

- The Quaternius pickup truck model (`terrain/public/models/pickup.glb` /
  `pickup-src.glb`) — CC0-1.0, no obligation.
- The five CC0 tree photo cutouts baked into `veg-atlas.png` — see
  `terrain/pipeline/VEG-ATLAS-SOURCES.md` for the per-source verification.

## CC-BY-4.0 — attribution required

"Range Rover" by IvOfficial, via Poly Pizza (`terrain/public/models/interior-car.glb`), is
CC-BY-4.0 and requires attribution. This is satisfied by the same `#credit` HUD line used for the
ODbL attribution above; do not remove it.

## Reference photography — not redistributed

NPS, USGS, and HABS photographs catalogued in `docs/PHOTOGRAPHIC-REFERENCE-REGISTER.md` and the
`terrain/pipeline/buildings/hero_candidates/*.json` records were used as look-development and
measurement reference only,
to inform reconstructions and material generation. They are not redistributed by this repository.

## Contributing an asset

Any new runtime asset needs an entry in `terrain/public/assets-manifest.json` — source, author,
license, attribution, and a repeatable recipe — and must pass `npm run validate:assets`.

Note on the manifest's `author` field: for third-party assets it names the upstream creator,
which is correct and must be preserved as-is. Project-generated assets use an impersonal project
form (e.g. "Grand Teton project") and must not carry any individual's name.
