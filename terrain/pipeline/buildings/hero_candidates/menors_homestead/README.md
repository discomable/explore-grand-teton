# Menor's Homestead hero-building candidate

This package is a draft-only batch input for Bill Menor's cabin and attached country store in the
Menors Ferry Historic District. It does not contain production assets and must not mutate the
production landmark manifest.

## Intended result

- `cabin`: the 1894 west wing and circa-1895 central cabin section.
- `country_store`: the larger circa-1905 east wing, physically attached to the cabin.

The country store is **not** the nearby building named `Menor's Storehouse`. The storehouse is the
separate storage/root-cellar building described by NPS. Its named repository footprint is retained
as a useful second registration anchor, but it is not rendered by this candidate.

The ferry, cableworks, Maud Noble Cabin, smokehouse, storehouse, and transportation barn are outside
this slice. In particular, the replica ferry is excluded because it needs separate river-contact,
current, cable, and thin-structure behavior.

## Source and placement contract

HABS WY-24 is the authoritative geometry source: its Library of Congress record contains eleven
photographs, twelve measured drawings, and five data pages. The NPS General Store page establishes
the three construction phases and the use of the east wing. NPS district/history pages establish
the site inventory and prevent same-site structures from being conflated.

`terrain/public/buildings.json` already includes uniquely named `Menor's Homestead` and
`Menor's Storehouse` features. Use the Homestead ring for the composite cabin/store placement and
the Storehouse ring only to check the HABS site transform. Record the source-file hash, exact rings,
cluster anchor, rotation, and both residuals in the run output.

## Required stage order

1. Acquire only the HABS WY-24 sheets, data pages, and same-building photographs needed for the
   cabin/store; record item-level rights, final URLs, retrieval dates, byte counts, and SHA-256.
2. Extract measured geometry, phase boundaries, roof junctions, and openings before modelling.
3. Register the HABS site plan to both named footprints and pass the placement residual gates.
4. Generate deterministic joined geometry and three LODs within the cluster budgets. Avoid
   coplanar faces, daylight gaps, or independent transforms at the cabin/store seam.
5. Render fixed orthographic targets, then use the image tool only for registered surface
   appearance. It may not decide openings, roof topology, dimensions, or phase boundaries.
6. Validate the six required day/overcast views. On failure, perform one targeted retry, then apply
   the matching quarantine status while allowing other candidates to continue.

Stop rather than guess if HABS measurements are unreadable, the named footprints conflict with the
site plan, image rights are unresolved, or a reference cannot be distinguished from another Menors
Ferry building.
