# Transport material assets

The two source albedo tiles in this directory were generated specifically for this project with
OpenAI's built-in image generation tool on 2026-07-28. They may be used, modified, and distributed
with this project under the same terms as the project.

## Files

- `dry-two-track-albedo.webp` — dry Grand Teton mineral soil, granite gravel, embedded stones, and
  sparse grass fragments. Generated as a flat-lit, orthographic, seamless material source and
  used for both two-track ruts and compacted gravel roads.
- `packed-trail-albedo.webp` — compacted hiking tread with granite grit, embedded flat stones, and
  restrained root fragments. Generated as a flat-lit, orthographic, seamless material source.

Both generated PNG sources were resized to 1024×1024 and encoded as WebP quality 86 with `cwebp`.
Directional lighting, wheel ruts, tread boundaries, and large standalone objects are intentionally
absent; those features are authored by runtime geometry and deterministic detail placement.
