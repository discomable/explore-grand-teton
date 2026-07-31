#!/usr/bin/env python3
"""Register a generated elevation back onto its clay target.

    python3 register_paint.py --clay wall1-clay.png --painted raw.png

Stage 5 of the hero-building pipeline. Image models do not preserve pixel
registration: asked to repaint a target in place, they return a plausible
building at their own scale and position. Observed drift on the chapel's entry
elevation was about 1.7x with a large offset -- invisible by eye, fatal to a
projection where every texel is tied to a measured face.

So registration is enforced here rather than requested in the prompt. The
generated silhouette is fitted onto the clay silhouette, the image is resampled
by that fit, and anything still outside the clay outline is cut away. What the
model is trusted for is material -- logs, chinking, weathering, openings --
not for where the building sits in the frame.

Reports the fit so a bad generation is caught before it becomes a texture.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[4]

TUNING = {
    # A clay pixel is background if it is close to the render's background
    # colour. Generated images come back with their own near-black, so the
    # test is "dark and desaturated" rather than an exact match.
    "background_luma": 0.22,
    "background_saturation": 0.10,
    "min_coverage": 0.96,      # share of the clay silhouette the fit must fill
    "min_iou": 0.95,           # silhouette agreement after fitting; 0.98 is achievable
    "edge_pad_px": 6,          # grow the source a little so edges stay covered
}


def load_rgb(path: Path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float64) / 255.0


def silhouette(image):
    """True where the image holds subject rather than background.

    Background is not merely "dark": a recessed doorway is darker than the
    empty frame and is very much subject. Only dark pixels reachable from the
    edge of the frame without crossing the building count as background, so an
    opening does not punch a hole in the silhouette and read as unpainted.
    """
    luma = image @ np.array([0.2126, 0.7152, 0.0722])
    saturation = image.max(axis=2) - image.min(axis=2)
    dark = (luma < TUNING["background_luma"]) & (saturation < TUNING["background_saturation"])
    outside = (np.minimum.accumulate(dark, axis=1)
               | np.minimum.accumulate(dark[:, ::-1], axis=1)[:, ::-1]
               | np.minimum.accumulate(dark, axis=0)
               | np.minimum.accumulate(dark[::-1], axis=0)[::-1])
    return ~outside


def bounds(mask):
    rows = np.flatnonzero(mask.any(axis=1))
    columns = np.flatnonzero(mask.any(axis=0))
    if not len(rows) or not len(columns):
        raise SystemExit("An image has no subject at all; check the background threshold.")
    return rows[0], rows[-1] + 1, columns[0], columns[-1] + 1


def fit(painted, clay_mask, painted_mask):
    """Resample `painted` so its silhouette lands on the clay silhouette.

    Independent x and y scale from the bounding boxes. The generated building
    is the same object at a different size, so matching extents recovers
    almost all of the drift; slight anisotropy costs nothing on a texture.
    """
    top, bottom, left, right = bounds(clay_mask)
    source_top, source_bottom, source_left, source_right = bounds(painted_mask)
    pad = TUNING["edge_pad_px"]
    scale_y = (source_bottom - source_top) / max(bottom - top, 1)
    scale_x = (source_right - source_left) / max(right - left, 1)
    height, width = clay_mask.shape
    grid_y, grid_x = np.mgrid[0:height, 0:width]
    sample_y = (grid_y - top) * scale_y + source_top
    sample_x = (grid_x - left) * scale_x + source_left
    sample_y = np.clip(np.round(sample_y), source_top - pad, source_bottom - 1 + pad)
    sample_x = np.clip(np.round(sample_x), source_left - pad, source_right - 1 + pad)
    sample_y = np.clip(sample_y, 0, painted.shape[0] - 1).astype(int)
    sample_x = np.clip(sample_x, 0, painted.shape[1] - 1).astype(int)
    return painted[sample_y, sample_x], (scale_x, scale_y)


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--clay", type=Path, required=True, help="the clay target from stage 3")
    parser.add_argument("--painted", type=Path, required=True, help="the generated image")
    parser.add_argument("--output", type=Path, help="default: <clay dir>/<view>-painted.png")
    parser.add_argument("--background", default="0.09,0.10,0.11",
                        help="fill colour outside the silhouette")
    opt = parser.parse_args()

    clay = load_rgb(opt.clay)
    painted = load_rgb(opt.painted)
    if clay.shape[:2] != painted.shape[:2]:
        painted = np.asarray(Image.open(opt.painted).convert("RGB")
                             .resize((clay.shape[1], clay.shape[0]), Image.LANCZOS),
                             dtype=np.float64) / 255.0

    clay_mask = silhouette(clay)
    painted_mask = silhouette(painted)
    warped, scale = fit(painted, clay_mask, painted_mask)
    warped_mask = silhouette(warped)

    overlap = float((warped_mask & clay_mask).sum())
    union = float((warped_mask | clay_mask).sum())
    iou = overlap / union if union else 0.0
    coverage = overlap / float(clay_mask.sum()) if clay_mask.any() else 0.0

    background = np.array([float(v) for v in opt.background.split(",")])
    result = np.where(clay_mask[..., None], warped, background)

    view = opt.clay.name.replace("-clay.png", "")
    output = opt.output or opt.clay.parent / f"{view}-painted.png"
    Image.fromarray((np.clip(result, 0, 1) * 255 + 0.5).astype(np.uint8)).save(output)

    report = {"view": view, "clay": str(opt.clay), "source": str(opt.painted),
              "sourceScale": [round(scale[0], 4), round(scale[1], 4)],
              "silhouetteIoU": round(iou, 4), "clayCoverage": round(coverage, 4),
              "output": str(output)}
    (opt.clay.parent / f"{view}-registration.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8")

    # scale is source extent over target extent, so it reads directly as how
    # much larger the model drew the building than the target it was given.
    print(f"  {view}: model drew it {scale[0]:.2f}x wide by {scale[1]:.2f}x tall, "
          f"refitted -> IoU {iou:.1%}, clay covered {coverage:.1%}")
    problems = []
    if coverage < TUNING["min_coverage"]:
        problems.append(f"only {coverage:.1%} of the clay silhouette got paint "
                        f"(need {TUNING['min_coverage']:.1%}) -- the generation does not "
                        "cover the shape; regenerate telling it to fill the whole form")
    if iou < TUNING["min_iou"]:
        problems.append(f"silhouettes agree only {iou:.1%} after fitting "
                        f"(need {TUNING['min_iou']:.0%}) -- the model drew a different shape, "
                        "not this building; regenerate")
    if problems:
        print("\nFAIL " + "\n     ".join(problems), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
