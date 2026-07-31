# models/ — drive-mode car model

## pickup.glb (game-ready) / pickup-src.glb (raw download)

- Model: **"Pickup Truck" by Quaternius** — a boxy 90s-style pickup with a palette
  texture atlas; reads realistic-adjacent and fits the existing "forest-service
  pickup around Jackson Hole" drive-mode fiction (sage-green paint, no less).
- Source page: https://poly.pizza/m/qn4grQgHm8 (creator listed as Quaternius,
  4,160 tris). Direct file downloaded:
  https://static.poly.pizza/4e925a01-dbb8-4aab-848b-221306b835ea.glb
- License: **CC0 1.0** — verified two places:
  1. The poly.pizza model page itself states `"Licence":"CC0 1.0"` in its embedded
     model metadata (and shows the CC0 badge).
  2. The model is from Quaternius' Cars pack (quaternius.com/packs/cars.html, which
     links https://creativecommons.org/publicdomain/zero/1.0/); the pack's own
     `License.txt` in the author's Google Drive distribution
     (folder 1fKlbDry77iY8KlEoxzUxIAZQL_XhzWlA, file 1CqsvhpIzBNSDlZsBWdJcJNC1B-TE3cXK)
     reads: "License: CC0 1.0 Universal (CC0 1.0) Public Domain Dedication".
- Sizes: pickup-src.glb 273 KB, pickup.glb 272 KB (well under the 8 MB budget).

### Processing (build-pickup.py, deterministic)

`pickup.glb` is rebuilt from `pickup-src.glb` by `build-pickup.py`:

- All node transforms baked to vertices; scaled ×0.82 → **1.90 m wide, 4.25 m
  long, 1.51 m tall, wheel r 0.36 m, wheelbase 2.55 m**; rotated so forward = -Z
  (game car convention); origin at ground under the axles.
- Window glass split out of the body by its palette colour (68,68,68 above the
  beltline) into a separate `Glass` node, and the cab greenhouse (roof, pillars,
  rear wall, mirrors above y 1.10 in the cab z-range) into `CabTop`. First person
  hides both: the atlas glass is opaque, and pillars would z-clip against the
  0.5 near plane on look-back.
- Wheels re-pivoted: vertices about each wheel centre, node translation = centre
  → runtime spins/steers the nodes directly. Nodes: `Body`, `Glass`, `CabTop`,
  `WheelFL`, `WheelFR`, `WheelB` (back pair shares one node, spin only).
- Material tweaks: paint roughness 0.55/metallic 0.25, glass rough 0.15/metal 0.6,
  BrakeLight base colour reddened (was grey in the source); Headlights/BrakeLight
  get runtime emissive for night lighting / brake glow (set in 82-drive.js).

## interior-car.glb (active drive-mode model — full interior)

- Model: **"Range Rover" by IvOfficial** — a low-poly Range Rover Classic SUV WITH a
  modeled interior (dashboard, seats, wipers, door panels), matching the Grand Teton
  first-person "drive-and-look-at-the-valley" reference far better than the pickup.
- Source page: https://poly.pizza/m/8zk4o6nALW  (2.18 MB glb).
- License: **CC-BY (Creative Commons Attribution)** — attribution: *"Range Rover" by
  IvOfficial, licensed CC-BY, via Poly Pizza.* NOTE: this is the project's first CC-BY
  asset — the "CC0/ODbL-only" rule was relaxed for the driving arc (2026-07-16, project
  decision) specifically to get a proper modeled interior; CC-BY requires this credit.
- Integration (82-drive.js `swapCarModel`, no offline processing): the model's node
  transforms are heavily baked (odd per-node scales + a root rotation), so it is
  AUTO-FIT at load — measure the loaded world bbox, rotate the long axis to Z and flip
  180° (its front is authored +Z; travel is -Z), scale to ~4.8 m long, centre X/Z and
  sit on the ground. The `Glass` material was authored `OPAQUE` (looked solid) → set
  transparent/opacity 0.16/depthWrite off at runtime so you can see out. First person
  needs no occluder hiding (real cabin + transparent glass); FP near plane already 0.12.
- The old `pickup.glb` (Quaternius CC0) is retained but no longer loaded.

## Loader

`GLTFLoader` is imported from the npm `three` package (`three/addons/loaders/GLTFLoader.js`,
pinned to three.js **r184** in `package.json`), not vendored. `terrain/src/main.js` imports it
and attaches it to the shared `THREE` object; `82-drive.js` calls `new THREE.GLTFLoader()` to
load `interior-car.glb` — the model actually loaded at runtime (see above).
