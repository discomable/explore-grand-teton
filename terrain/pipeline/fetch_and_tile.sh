#!/usr/bin/env bash
# End-to-end: fetch DEM -> reproject to UTM 12N meters -> fill voids -> terrain-RGB -> tile pyramid.
# Requires: gdal (>=3.4), rio-rgbify, cwebp, and $OT_API_KEY.
set -euo pipefail

# ---- config -----------------------------------------------------------------
DATASET="${DATASET:-USGS1m}"      # USGS1m (near-field) | USGS10m (base)
WEST=-110.90; SOUTH=43.55; EAST=-110.55; NORTH=43.92   # park bbox — edit me
UTM=EPSG:32612                    # UTM zone 12N (Tetons)
RES="${RES:-1}"                   # target meters/pixel (1 for 1m, 10 for the base)
STEP="${STEP:-0.02}"              # per-request chunk (deg). 10m fits the whole bbox: STEP=1.0
TILESIZE=512
OUT="$(cd "$(dirname "$0")/.." && pwd)/public"   # terrain/public — absolute (we cd into WORK below)
WORK=work
PY="${PY:-$(cd "$(dirname "$0")" && pwd)/.venv/bin/python3}"   # pipeline venv
[ -x "$PY" ] || PY=python3
# -----------------------------------------------------------------------------

mkdir -p "$WORK" "$OUT"
cd "$WORK"

echo "== 1/6 fetch (chunked) =="
"$PY" ../chunk_fetch.py --dataset "$DATASET" --step "$STEP" \
  --west $WEST --south $SOUTH --east $EAST --north $NORTH --out raw_dem.tif

echo "== 2/6 reproject -> $UTM @ ${RES}m =="
gdalwarp -t_srs "$UTM" -tr "$RES" "$RES" -r bilinear -multi \
  -co BIGTIFF=YES -co TILED=YES -co COMPRESS=DEFLATE \
  -overwrite raw_dem.tif dem_utm.tif

echo "== 3/6 fill nodata voids =="
gdal_fillnodata.py -md 40 dem_utm.tif dem_filled.tif

echo "== 5/6 cut terrain-RGB pyramid {z}/{x}/{y}.webp =="
# custom tiler: every zoom is downsampled in HEIGHT space then encoded — never resample packed
# RGB bytes (gdal2tiles overview averaging injects ±6553 m spikes). Writes opaque lossless webp.
rm -rf "$OUT/tiles"
"$PY" ../tile_pyramid.py dem_filled.tif "$OUT/tiles" --tilesize $TILESIZE

echo "== 6/6 manifest =="
"$PY" ../make_manifest.py --dem dem_filled.tif --tiles "$OUT/tiles" \
  --tilesize $TILESIZE --dataset "$DATASET" --res "$RES" --out "$OUT/tiles.json"

echo "Done. Tiles + tiles.json in $OUT"
