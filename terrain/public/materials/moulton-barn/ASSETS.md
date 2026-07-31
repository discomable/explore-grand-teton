# T. A. Moulton Barn material atlas

`moulton-barn-atlas.webp` is a 1024×512, two-cell albedo atlas:

- left 512×512: horizontally coursed, weathered hand-hewn logs;
- right 512×512: dark board-and-batten roof timber.

Both source textures were generated for this project with OpenAI image generation,
using the public-domain 1977 HABS photograph and a CC BY 4.0 modern photograph as
visual references. No source pixels were copied into the generated output.

Generation prompts requested orthographic, evenly lit, tileable albedo with no
scene context, baked shadows, highlights, text, or watermark. The sources are
kept under the ignored `terrain/pipeline/data/moulton-barn/imagegen-output/`.

The Blender reconstruction cube-projects UVs into the relevant atlas half. At
runtime all three GLB LODs share one `Texture` object, so only one atlas remains
resident despite the separate LOD files.

## Image-assisted front elevation

`front-projection-v2.webp` is the active 1536×1024 registered facade projection generated
with OpenAI's built-in image tool. The edit target was a neutral orthographic
render of the measured LOD0; the public-domain 1977 HABS photograph and licensed
2018/2024 photographs of the same T. A. Moulton barn supplied surface reference.
The neighboring gambrel-roof John Moulton barn photograph was explicitly excluded.

The prompt required exact target silhouette, proportions, roof pitch, framing and
pixel registration; weathered horizontal logs and pale chinking; irregular vertical
gable boards; rough plank openings; diffuse calibration lighting; no landscape,
new geometry, text or watermark. Only front-facing LOD0 timber polygons use this
projection. Other faces and lower LODs retain the compact tileable atlas.

V2 is a constrained edit of V1 that corrects the asymmetric access doors, paired
main doors and small upper openings against the HABS and modern west elevations,
while explicitly avoiding featureless black rectangles. V1 remains alongside it
as the reversible proof-of-concept source.
