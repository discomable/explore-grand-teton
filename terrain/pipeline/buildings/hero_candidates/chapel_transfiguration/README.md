# Chapel of the Transfiguration hero-building candidate

This package is a draft-only batch-orchestrator input for the Chapel of the Transfiguration at
Moose. It does not contain production assets and must not mutate the production landmark
manifest.

## Intended result

- `chapel`: exterior hero landmark using the exact named footprint and the official National
  Register's approximately 22-by-50-foot primary massing.
- `brides_room`: low-detail immediate companion massing using its distinct named footprint.

The scope is deliberately exterior-only. A walkable or portal-loaded interior, the altar-window
interior vista, furnishings, bell canopy, storage shed, and nearby Menor's Ferry buildings are not
part of this candidate. An interior would require a separately approved budget and workflow.

`candidate.json` owns placement, single-building budgets, LOD intent, projection constraints,
validation, and quarantine gates. `reference-sources.json` owns official-source identity,
licensing, confidence, and acquisition requirements. `architecture.json` separates documented
facts from unresolved geometry and prevents the image tool from determining architecture.

## Strong source basis

The official National Register nomination documents the main chapel's approximate dimensions,
horizontal saddle-notched lodgepole-log construction, shake-covered gables, roughly 14-foot-square
sacristy, spear-ended fascias, entrance door, side lattice casements, and altar-window opening. The
repository's current building extract contains unique exact-name footprints for both the chapel
and Brides' Room. No same-building HABS record was identified in the initial official-source
search, so the nomination—not a lookalike chapel—is the primary architectural record.

## Required stage order

1. Acquire only the required National Register pages and selected rights-resolved NPS exterior
   images; record final URL, creator, rights, retrieval date, byte count, and SHA-256.
2. Resolve both exact named footprint records and compare their vertices and relative placement
   with the snapshots in `candidate.json`.
3. Resolve roof pitches, heights, projections, and opening positions from LiDAR, an official
   measured source, or calibrated same-building evidence. Retain every unresolved value as such.
4. Generate deterministic closed exterior geometry and all three LODs within the single-candidate
   budget shared by the chapel and Brides' Room.
5. Render fixed orthographic exterior targets. Invoke an image tool only after two useful
   same-building exterior elevations have item-level rights metadata.
6. Validate close, approach, and distant captures in daylight and overcast. Perform one targeted
   retry on failure, then apply the matching quarantine status.

Stop rather than speculate if the named footprints drift, exterior-image rights remain unclear,
the Brides' Room form cannot be verified, or a reference might depict the Chapel of the Sacred
Heart. The signature view through the altar window is context for orientation only and must never
be baked into an exterior façade.
