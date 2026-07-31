# hero building pipeline

Rebuilds one named building as a measured landmark: LiDAR owns the roof and
footprint, generated imagery owns the wall surfaces.

Written to be run start-to-finish by a small model. Every stage takes a
building **name**, never coordinates. Every stage self-checks and exits
non-zero when a check fails. **Do not continue past a failing stage, and do not
hand-edit a generated JSON to make a check pass** — each check prints a
`nextAction` telling you which knob to turn in the script's `TUNING` block.

## Setup (once)

```sh
python3 -m venv terrain/pipeline/.venv
terrain/pipeline/.venv/bin/pip install -r terrain/pipeline/buildings/hero/requirements.txt
```

`terrain/pipeline/` is gitignored below `data/` and `work/`, so the venv is
local-only. Every command below uses `terrain/pipeline/.venv/bin/python`.

## What the LiDAR can and cannot give you

Measured on the 2022 3DEP tile over the T. A. Moulton Barn: **27.6 points/m²**
across the tile, **19–21 points/m² on the structure** — about one return every
22 cm. That is enough to fit roof planes to ~4 cm RMS.

But 3,825 of the barn's 3,900 structure returns are **first return**, and they
span only 4.5 m vertically starting 1.9 m above ground. Aerial LiDAR sees the
**roof and the drip edge, not the walls**. So:

| Feature | Source |
|---|---|
| Roof planes, pitches, ridge lines, overhang outline | LiDAR (stage 1) |
| Building position and orientation | named footprint in `buildings.json` |
| Wall lines | extruded from each measured eave down to draped terrain |
| Logs, chinking, doors, windows, weathering | generated imagery (stage 3+) |

Do not expect an eave height to be a measured wall top. The `eaveAglM` in
`roof.json` is the lowest roof edge — the wall meets it, and everything below
is extrusion.

## Stage 0 — `hero_fetch.py`

```sh
terrain/pipeline/.venv/bin/python terrain/pipeline/buildings/hero/hero_fetch.py \
  --building "Chapel of the Transfiguration"
```

Derives the search area from the named footprint, finds the covering USGS 3DEP
tiles, and downloads them to `terrain/pipeline/data/hero/<slug>/` with a
`download_manifest.json` recording URL, size and SHA-256. `--list` shows what
is available and downloads nothing. It prints the command for stage 1 when it
finishes.

It prefers `WY_GrandTetonNP_D22` (~27 points/m² over the park) and says so.
If no preferred project covers the building it falls back to the most recent
and **says that too** — treat that as a warning and check
`structure_density` in stage 1 before trusting the result. `--project` forces
a specific one.

Buildings near a tile seam are covered by two tiles; it downloads all that
overlap, and stage 1 accepts the directory.

## Stage 1 — `hero_lidar.py`

```sh
terrain/pipeline/.venv/bin/python terrain/pipeline/buildings/hero/hero_lidar.py \
  --building "T. A. Moulton Barn" \
  --laz terrain/pipeline/data/moulton-barn/ \
  --output terrain/pipeline/work/hero/ta-moulton-barn/roof.json
```

`--laz` takes a single file or a directory of tiles — normally the directory
stage 0 just wrote. Tiles that miss the footprint are skipped. `--list` prints
every named footprint and exits.

Writes `roof.json`: ground elevation, per-plane normal/pitch/downslope
azimuth/RMS/outline, ridge segments with endpoints, the drip-edge ring, and the
`checks` array. All coordinates are in the **runtime world frame**
(`x` east of centre, `z` south of centre, elevation in metres), so nothing
downstream has to touch a CRS.

Known-good result for the barn:

```
4 planes, 3397 points at 19.1/m2, ridge 6.16 m AGL, coverage 96%
  plane0:  1142 pts  pitch  15.2 deg  faces  182.4 deg  rms 0.037 m    88.7 m2
  plane1:  1071 pts  pitch  15.2 deg  faces  351.5 deg  rms 0.041 m    90.8 m2
  plane2:   655 pts  pitch  41.0 deg  faces  180.5 deg  rms 0.053 m    29.9 m2
  plane3:   395 pts  pitch  42.1 deg  faces  356.1 deg  rms 0.061 m    26.9 m2
  ridge plane2+plane3: 11.50 m long at 6.08 m AGL
```

That is the barn's real architecture recovered without interpretation: two
15° shed roofs facing south and north, a 41° central gable, one ridge. The
previous pipeline replaced all of this with five scalars and a hand-tuned
`core = span / 3.02`.

Second worked example, the Chapel of the Transfiguration — a different roof
form:

```
3 planes, 2486 points at 21.0/m2, ridge 5.54 m AGL, coverage 79%
  plane0:   981 pts  pitch  38.0 deg  faces  230.5 deg  rms 0.046 m    40.8 m2
  plane1:   786 pts  pitch  38.4 deg  faces   50.7 deg  rms 0.045 m    42.4 m2
  plane2:   207 pts  pitch  35.8 deg  faces  141.7 deg  rms 0.052 m    11.9 m2
  ridge plane0+plane1: 13.00 m long at 5.64 m AGL
  stopped: next plane held 184 points at 4.4/m2, below 40% of the structure's 21.0/m2
```

`plane0`/`plane1` are the main nave roof; `plane2` is a smaller cross gable at
one end, roughly perpendicular. **`plane2` has no opposing partner** — only one
side of that cross gable is recoverable from the cloud, so stage 2 has to close
it against the drip edge rather than expect a matching plane. Drip edge and
mapped footprint centroids agree to 0.41 m.

Note the drip edge comes out **smaller** than the mapped footprint, not larger
as an overhang would suggest — 89.3 m² against 118.3 m² here, and 149.0 against
178.1 on the barn. Roof-edge returns thin out and the outline is closed with an
erode/dilate pass, so it under-reads by 15–25%. Stage 2 should take the wall
line from the mapped footprint and use the drip edge only for overhang *shape*.
The `footprint_scale` check allows 0.7–1.9 to cover this.

Coverage is 79% here against the barn's 96%. The 512 unexplained returns sit
entirely within the roof's own elevation band, a median 0.37 m off the nearest
fitted plane and spread across the whole footprint — a diffuse halo from a
rougher roof, not a missed facet. Nothing sits above the ridge, so there is no
tower in the data despite the chapel having a bell cote.

### Reading the output

- `downslopeAzimuthDeg` is a compass bearing: 0° = north, 90° = east, 180° =
  south. It decides which elevation each plane belongs to, so it is the field
  stage 3 depends on most. Sanity-check it against a photograph before
  continuing.
- `planarRmsM` above ~0.10 m means the plane is absorbing two real surfaces.
  Raise `max_planes` and re-run.
- `ridges` only lists pairs that are opposed, level, physically adjacent, **and**
  sit on opposite sides of the line. A shed on each side of a barn satisfies the
  first three and is correctly rejected.
- `rejectedSparsePlanes` records where segmentation stopped. Once the real
  facets have claimed their inliers the residue still fits a plane — usually one
  near-parallel to a real roof and smeared across the whole building — and it
  would invent ridges underneath the real one. Real facets run 0.6–1.2× the
  structure's overall density; scatter runs 0.15–0.2×, so the 40% gate separates
  them cleanly. A non-empty entry is normal, not a failure.
- `coverage` below ~85% is worth a look but is not automatically wrong. Check
  whether the leftovers form a coherent patch (a facet the segmenter missed —
  raise `max_planes`) or a diffuse halo around the fitted planes (a rough roof —
  leave it alone).

### When a check fails

Each failure prints the measured value, the threshold, and a `nextAction`.
The three you will actually hit:

| Check | Usual cause | Fix |
|---|---|---|
| `structure_density` | tile is QL2 or coarser | Source a denser tile. This building cannot get an exact silhouette; do not lower the threshold. |
| `plane_coverage` | tree canopy inside the crop | Lower `footprint_margin_m`, or raise `max_planes` for a genuinely complex roof. |
| `footprint_agreement` | wrong tile, wrong footprint, or wrong CRS | Stop. Do not tune anything — resolve which of the three is wrong. |

`structure_points` failing usually means the tile does not cover the building
at all; the script says so explicitly before it gets that far.

### Buildings with no class-6 returns

Classification is inconsistent across tiles: the barn's and the chapel's both
carry class 6, the Cunningham tile has none at all. The script only trusts class 6 when there is enough of it
and otherwise self-classifies (inside the footprint, above ground, single
return, noise classes dropped). Forced onto the barn, the self-classified path
recovers the same four planes to within 0.3° of pitch and azimuth at identical
RMS, and finds 202 extra eave returns. Either path is fine; `structureMethod`
records which ran.

### Buildings with no mapped footprint

`hero_lidar.py` refuses to run without a named footprint, because placement is
the most damaging landmark error and the footprint is what fixes it. Of the six
candidates, **Chapel of the Transfiguration** (+ Brides' Room), **Menor's
Homestead** (+ Storehouse, Pole Barn), **Jenny Lake Ranger Station** and
**Manges Cabin** already have named footprints. **Cunningham Cabin** and **Andy
Chambers** do not — their footprints must be added to the buildings pipeline
first.

## Stage 2 — `heroblock.py`

```sh
terrain/pipeline/.venv/bin/python terrain/pipeline/buildings/hero/heroblock.py \
  --roof terrain/pipeline/work/hero/ta-moulton-barn/roof.json
```

Writes `<slug>-lod0/1/2.glb` and `<slug>-geometry.json` beside the roof file.
Refuses to run if any stage 1 check failed. glTF is written directly; Blender
is not involved.

```
  registered roof onto footprint: moved 2.45 m (dx -2.43, dz -0.34)
  LOD0:   275 tris ( 83 roof + 192 wall), roof covers 99% of the footprint
  LOD1:    87 tris ( 19 roof +  68 wall), roof covers 98% of the footprint
  LOD2:    46 tris ( 10 roof +  36 wall), roof covers 98% of the footprint
```

Roof triangles lie on the measured planes. Walls are extruded from the roofline
down through the ground by a skirt, so sloping terrain cannot open a gap at the
base. The wall top follows the roof and inserts exact ridge crossings, so a
gable end keeps its point. Everything is left as plain surfaces deliberately —
detail arrives as projected imagery in stages 3–6.

The result is ~250 triangles against a 5000 budget. That is expected: this is a
measured shell, not the old hand-detailed barn, and invented relief here would
only fight the projection.

### Registration

The measured roof and the mapped footprint do not always coincide. The barn's
disagree by **2.45 m**, the chapel's by 0.14 m. Unregistered, the barn's roof
hangs off one end and leaves a 3.7 m strip of the footprint with no roof at all.

LiDAR owns the shape; the footprint owns placement and collision, so the roof
is translated onto the footprint and the shift is printed whenever it exceeds
1 m. A large shift is worth checking against an orthophoto — it means either
the footprint or the tile is misplaced, and stage 1's `footprint_agreement`
check tolerates up to 3 m, so it will not catch this for you.

### Why the roof is bounded

Nearest-plane assignment gives every cell in the outline an owner however far
away that plane's returns are, so a 41° gable will happily run metres past its
own measurement. Three constraints hold it in:

- **Elevation band** — a plane is never carried above the highest elevation it
  was measured at (+0.10 m tolerance), and only `below_eave_m` beneath the
  lowest, which is the real overhang. This is what actually bounds the height:
  the ridge stays within +0.10 m whether `max_extrapolation_m` is 1.25 m or 4 m.
- **Ridge clipping** — a plane stops at every ridge it forms. Without it a
  gable climbs straight over its own ridge.
- **Extrapolation limit** — lateral spread only, now that height is handled.

Walls are clamped the same way and take their height from the region they fall
in. Reading the nearest plane instead let wall tops burst through the ridge and
stand 0.7–1.1 m proud of the roof, which the roof-only numbers do not show — so
check the **wall** peak against the roof peak, not just the roof against the
measurement.

### When a check fails

`roof covers only N% of the footprint` is a hard gate, because a hole in a roof
is see-through. It almost always means stage 1 missed a plane rather than that
`max_extrapolation_m` is too small — the chapel's 88% was its cross gable
having no opposing partner. Fix stage 1 first.

Per-LOD coverage floors are 94/90/85%: coarser LODs simplify their own edges
away, and at 260 m a small gap is invisible.

## Stage 4 — image generation

Generate against `<view>-gen.png`, **never** `<view>-clay.png`. The clay target
is letterboxed so all five views share one pixels-per-metre scale, and that
margin is what breaks generation: image models normalise a subject to fill the
frame. From the letterboxed target one model returned the chapel's entry
elevation 1.60x wider and 1.95x taller -- exactly the 52%/33% it occupied
pushed to 83%/64%. From the filled-frame crop the same model returned 1.00x.

No wording prevents it. `edit_image` exposes only `{prompt, file}`: no mask
channel, no denoise strength, no structural conditioning. The strictest stencil
prompt scored worst of the three tried.

Rules that mattered in practice:

- A wall view is **wall only**. Asking for a roof gets eaves and overhangs
  drawn outside the silhouette. The roof has its own camera.
- Name the material, not the building type. "Weathered horizontal round logs
  about 28 cm thick, pale lime chinking, projecting saddle-notched log ends"
  lands; "log chapel" invites reinterpretation.
- Forbid the setting explicitly: no sky, ground, sagebrush, trees, people,
  signs, text, cast shadows. Flat even lighting, because baked sun would fight
  the game's own.

## Stage 5 — `register_paint.py`

```sh
terrain/pipeline/.venv/bin/python terrain/pipeline/buildings/hero/register_paint.py \
  --clay .../elevations/wall1-clay.png --painted .../elevations/raw/wall1-raw.png
```

Fits the generated silhouette onto the clay silhouette, resamples, and cuts
away anything outside the outline -- including mapping the filled-frame crop
back into the letterboxed frame, which the bounding-box fit handles for free.
The model is trusted for material and never for placement.

Fails below 96% coverage or 95% silhouette agreement. The chapel's five views
landed at 96.9-99.0% IoU with 98.5-99.9% covered.

Note that background means *dark and reachable from the edge of the frame*, not
merely dark. A recessed doorway is darker than the empty frame; treating it as
background scored a good generation as 12% unpainted.

## Stage 6 — `apply_textures.py`

```sh
terrain/pipeline/.venv/bin/python terrain/pipeline/buildings/hero/apply_textures.py \
  --building terrain/pipeline/work/hero/<slug>
```

Packs the four wall elevations into one 2x2 atlas and the roof into its own
image, then gives every triangle UVs by projecting through the camera stage 3
recorded. Writes three textured GLBs plus two JPEGs.

- **Two materials, not five.** Four wall textures would put LOD0 at seven
  material primitives against a budget of four.
- **Cameras come from `elevations.json`,** not recomputed. Recomputing derives
  the scale from each LOD's own vertex bounds, so the LODs would drift apart.
- **Textures are referenced, not embedded.** Embedding put the same 504 KB in
  all three LODs; referencing them dropped the set from 1.6 MB to 616 KB.

Chapel result: 504 KB of texture against a 1.5 MB budget, GLBs at 65/26/20 KB.

## Publishing

Copy the GLBs and JPEGs into `terrain/public/models/` and add a record to
`terrain/public/landmarks.json` with the world position stage 2 printed. The
generic extrusion is suppressed automatically -- `92-boot.js` derives
`replacementNames` from `landmarks.json`, so adding a landmark does not also
mean editing a list in the boot code.
