#!/usr/bin/env python3
"""Compare captured review shots against approved visual baselines.

Matches PNGs by filename, writes actual/baseline/diff images and an HTML report.
Requires Pillow (``python3 -m pip install Pillow``).
"""
import argparse
import html
import shutil
import sys
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageEnhance
except ImportError:
    sys.exit("visual_compare.py requires Pillow; install it with: python3 -m pip install Pillow")

ROOT = Path(__file__).resolve().parent


def parse_limit(value):
    """Parse an absolute pixel count or a percentage such as ``0.5%``."""
    try:
        if value.endswith("%"):
            result = float(value[:-1])
            if not 0 <= result <= 100:
                raise ValueError
            return "percent", result
        result = int(value)
        if result < 0:
            raise ValueError
        return "count", result
    except ValueError:
        raise argparse.ArgumentTypeError("must be a non-negative count or percentage (for example 250 or 0.5%)")


def pngs(directory):
    return {path.name: path for path in sorted(directory.glob("*.png"))}


def diff_images(actual_path, baseline_path, threshold):
    with Image.open(actual_path) as source, Image.open(baseline_path) as approved:
        actual, baseline = source.convert("RGBA"), approved.convert("RGBA")
    if actual.size != baseline.size:
        return None, actual, baseline, 0, 0, "image dimensions differ"
    raw = ImageChops.difference(actual, baseline)
    changed = sum(max(pixel) > threshold for pixel in raw.get_flattened_data())
    return ImageEnhance.Brightness(raw).enhance(4), actual, baseline, changed, actual.width * actual.height, None


def report_html(rows, threshold, limit):
    limit_text = f"{limit[1]}%" if limit[0] == "percent" else str(limit[1])
    sections = []
    for row in rows:
        figures = "".join(
            f'<figure><figcaption>{label}</figcaption><img src="{html.escape(filename)}" alt="{label} for {html.escape(row["name"])}"></figure>'
            for label, filename in row["images"]
        )
        sections.append(f'<section class="{"pass" if row["passed"] else "fail"}"><h2>{html.escape(row["name"])}: {row["status"]}</h2><p>{html.escape(row["detail"])}</p><div class="images">{figures}</div></section>')
    return f"""<!doctype html><html lang="en"><meta charset="utf-8"><title>Visual comparison report</title>
<style>body{{font:16px system-ui,sans-serif;margin:2rem;max-width:1400px}}section{{padding:1rem;margin:1rem 0;border-left:6px solid}}.pass{{border-color:#198754}}.fail{{border-color:#c62828}}.images{{display:flex;gap:1rem;flex-wrap:wrap}}figure{{margin:0;max-width:31%}}img{{width:100%;height:auto;border:1px solid #bbb}}figcaption{{font-weight:600;margin-bottom:.3rem}}</style>
<h1>Visual comparison report</h1><p>Per-channel pixel tolerance: {threshold}. Allowed changed pixels: {limit_text}.</p>{''.join(sections)}</html>"""


def main():
    parser = argparse.ArgumentParser(description="Compare shots/ PNGs with visual-baselines/ PNGs.")
    parser.add_argument("--shots-dir", type=Path, default=ROOT / "shots", help="capture directory (default: shots)")
    parser.add_argument("--baselines-dir", type=Path, default=ROOT / "visual-baselines", help="approved PNG directory")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "visual-results", help="report and generated images directory")
    parser.add_argument("--pixel-threshold", type=int, default=12, metavar="0..255", help="ignore pixels whose largest channel delta is at most this value (default: 12)")
    parser.add_argument("--max-diff-pixels", type=parse_limit, default=("percent", 0.0), metavar="COUNT|PERCENT%", help="maximum changed pixels allowed (default: 0%%)")
    args = parser.parse_args()
    if not 0 <= args.pixel_threshold <= 255:
        parser.error("--pixel-threshold must be between 0 and 255")
    for directory, label in ((args.shots_dir, "shots"), (args.baselines_dir, "baselines")):
        if not directory.is_dir():
            parser.error(f"{label} directory does not exist: {directory}")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    shots, baselines = pngs(args.shots_dir), pngs(args.baselines_dir)
    names = sorted(set(shots) | set(baselines))
    if not names:
        parser.error("no PNG files found in either directory")

    rows, failures = [], 0
    for name in names:
        stem, actual_path, baseline_path = Path(name).stem, shots.get(name), baselines.get(name)
        images, status, detail, passed = [], "PASS", "", True
        if not actual_path or not baseline_path:
            passed, status = False, "FAIL"
            detail = "missing " + ("capture" if not actual_path else "approved baseline")
            source, label = (actual_path or baseline_path), ("Actual" if actual_path else "Baseline")
            filename = f"{stem}-{label.lower()}.png"
            shutil.copyfile(source, args.output_dir / filename)
            images.append((label, filename))
        else:
            diff, actual, baseline, changed, total, error = diff_images(actual_path, baseline_path, args.pixel_threshold)
            for label, image in (("Actual", actual), ("Baseline", baseline)):
                filename = f"{stem}-{label.lower()}.png"
                image.save(args.output_dir / filename, format="PNG")
                images.append((label, filename))
            if error:
                passed, status, detail = False, "FAIL", error
            else:
                filename = f"{stem}-diff.png"
                diff.save(args.output_dir / filename, format="PNG")
                images.append(("Diff (4x)", filename))
                percentage = changed / total * 100
                allowed = args.max_diff_pixels[1] * total / 100 if args.max_diff_pixels[0] == "percent" else args.max_diff_pixels[1]
                passed, status = changed <= allowed, "PASS" if changed <= allowed else "FAIL"
                detail = f"{changed:,} / {total:,} pixels changed ({percentage:.3f}%)."
        failures += not passed
        rows.append({"name": name, "status": status, "detail": detail, "passed": passed, "images": images})
    report = args.output_dir / "report.html"
    report.write_text(report_html(rows, args.pixel_threshold, args.max_diff_pixels), encoding="utf-8")
    print(f"visual comparison: {len(rows) - failures} passed, {failures} failed; report: {report}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
