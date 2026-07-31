# Atlas candidates — CC0 cutout tree textures

Provenance for the photo billboard atlas (cells 256x512) that ScatterManager.js composites
into `terrain/public/veg-atlas.png`, replacing the older procedural atlas. Species targets:
conifer/lodgepole x2, spruce-fir spire, aspen x2, cottonwood. Source files live in
`terrain/public/atlas-candidates/` (gitignored; not shipped in git — see .gitignore).

All files below have a real alpha channel (verified RGBA, corner alpha = 0).

---

## 1. oga_rubberduck_conifers_2K_atlas.png — conifers + spruce-fir spire

- Source: https://opengameart.org/content/high-res-tree-textures ("high-res tree textures"
  by rubberduck), file `trees_2K.zip` -> `tree_collection_2K.png`
  (https://opengameart.org/sites/default/files/trees_2K.zip)
- License: CC0 — verified on the OpenGameArt submission page itself, which lists the asset
  under the CC0 license tag. Author states trees are "based on my own photos".
- Resolution: 6315x2048, sheet of 7 individual photo-cutout spruce/pine trees.
  Normal-map twin (`tree_collection_2K_n.png`) was deleted after unzip; re-download the zip
  if needed. A 1K zip and dead-tree packs (trees_dead_1K/2K.zip) exist at the same source.
- Sub-tree x-ranges (alpha-scanned, full height 0-2048):
  - tree1: x 17-965 — full skirt, classic spruce
  - tree2: x 997-1866 — sparser, leaning tip, lodgepole-ish
  - tree3: x 1876-2940 — dense, light snow patches (snow may look wrong in summer scenes)
  - tree4: x 2948-3955 — open irregular crown, good lodgepole stand-in
  - tree5: x 3965-4880 — mid-density spruce
  - tree6: x 4892-5458 — very narrow spire, ideal spruce-fir/subalpine-fir column
  - tree7: x 5474-6283 — tall regular spire, second conifer column
- Suitability: excellent. True photo cutouts, clean alpha edges (checked at 100% crop),
  neutral lighting. Covers conifer/lodgepole x2 and the spruce-fir spire. These are
  European spruce, not literally Pinus contorta, but silhouettes read correctly at
  billboard distance. 2048 px height downsamples cleanly to 512-cell height.

## 2. cgbookcase_tree04_deciduous_3K.png — cottonwood (primary)

- Source: https://www.cgbookcase.com/textures/tree-04 (cgbookcase.com, Dorian Zgraggen).
  Direct file: https://cgbookcase.b-cdn.net/textures/thumbnails/Tree04/Tree04_3K.png
- License: CC0 1.0 — verified two places on the site: the textures index
  (https://www.cgbookcase.com/textures) states all textures are under the "CC0 1.0
  license", and the individual texture page carries `<meta name="tex1:license"
  content="cc0">` plus "(cc0 texture)" in its description.
- Resolution: 3078x3000.
- Suitability: big dense rounded broadleaf crown with short massive trunk — the best
  cottonwood read of the set. Likely a European lime/oak, not Populus deciduosa, but the
  broad-canopy silhouette matches valley-bottom cottonwood well.

## 3. cgbookcase_tree01_deciduous_3K.png — cottonwood (alternate)

- Source: https://www.cgbookcase.com/textures/tree-01
  Direct file: https://cgbookcase.b-cdn.net/textures/thumbnails/Tree01/Tree01_3K.png
- License: CC0 1.0 — verified same as above (site-wide statement + per-page cc0 meta on
  the tree-01 page).
- Resolution: 3310x3481.
- Suitability: broad darker crown, visible single trunk. Slightly cooler/darker foliage —
  good as a second cottonwood or mature-broadleaf variant. Alpha edge clean.

## 4. cgbookcase_tree05_deciduous_3K.png — aspen stand-in 1

- Source: https://www.cgbookcase.com/textures/tree-05
  Direct file: https://cgbookcase.b-cdn.net/textures/thumbnails/Tree05/Tree05_3K.png
- License: CC0 1.0 — verified same as above.
- Resolution: 1526x3000 (tall/slender — matches a 256x512 cell aspect nicely).
- Suitability: slender upright young broadleaf (maple — samaras visible up close), open
  airy crown, pale slim trunk. Best aspen silhouette of the CC0 material found. Caveats:
  leaves are maple-shaped (irrelevant at billboard scale) and there is minor white edge
  fringing on backlit leaves — recommend an alpha-dilate / premultiply pass when baking
  the atlas.

## 5. cgbookcase_tree07_deciduous_3K.png — aspen stand-in 2

- Source: https://www.cgbookcase.com/textures/tree-07
  Direct file: https://cgbookcase.b-cdn.net/textures/thumbnails/Tree07/Tree07_3K.png
- License: CC0 1.0 — verified same as above.
- Resolution: 1845x3000.
- Suitability: small round crown on a long thin bare trunk — reads as a young
  aspen/birch. Pairs with tree05 to give the two required aspen columns; tinting toward
  yellow-green (or gold for fall) in the bake would strengthen the aspen read.

---

## Honest gaps / rejected sources

- TRUE quaking aspen (white bark, round leaves) and TRUE narrowleaf/plains cottonwood
  cutouts under genuine CC0 were NOT found. The cgbookcase trees are European broadleaf
  species standing in on silhouette. If botanical fidelity matters, the options are
  CC-BY/commercial libraries (rejected: not CC0) or cutting out PD US-government photos
  (rejected: masking work + PD status of specific photos would need per-photo checks).
- Wikimedia Commons: searched CC-Zero-category and structured-data-license queries
  ("populus", "tremula", "cottonwood", "freigestellt", transparent-background plant
  categories). Commons transparent-background tree content is icons/SVG/clipart; the good
  photoreal cutouts there are CC-BY-SA (attribution + share-alike — unusable as CC0).
- OpenGameArt "60 CC0 Vegetation textures" (burningwell): downloaded and contact-sheeted —
  leaves/branches/grass only, no full trees. Not kept.
- Kenney: nature assets are stylized flat vector / low-poly 3D, not photoreal billboards.
- Poly Haven: CC0 3D tree models only, no cutout/billboard renders to download.
- klamtii.itch.io/tree-sprites: 30 Blender-rendered tree sprites (conifer + birch groups)
  with CC0-equivalent wording on the page; rendered style is less photoreal than the
  above and the download needs the itch purchase flow, so not downloaded. Worth a look if
  rendered impostors are acceptable.

## Atlas-bake notes (as wired into ScatterManager.js)

- 8 columns x (256x512): conifer = atlas tree7 + tree4 + tree2, spruce-fir spire =
  atlas tree6, aspen x2 = cgbookcase tree05 + tree07, cottonwood = cgbookcase tree04
  + tree01.
- Downsample with premultiplied alpha and dilate edge color to kill halos (tree05
  especially); avoid snow tree3 unless winter.
- All sources re-verified 2026-07-10.
