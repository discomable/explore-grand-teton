#!/usr/bin/env bash
# Bake the 1 m lidar heights onto the shared 1.25 m dyadic grid and retile the height pyramid.
# Run AFTER fetch_1m_tnm.py has produced work1m/raw_dem_1m.vrt.
#
# Grid: same extent as tiles.json, 1.25 m (= 10 m / 8) so imagery/height tile indices stay aligned
# and maxZoom becomes 7. Voids in the 1 m collection are filled from the upsampled 10 m DEM.
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"

PIPE="$(cd "$(dirname "$0")" && pwd)"
PY="$PIPE/.venv/bin/python3"
OUT="$PIPE/../public"
W1="$PIPE/work1m"
RES=1.25
# extent from tiles.json (locked — must match the imagery grid family)
TE="508020.8068557632 4821916.167973563 536340.8068557632 4863096.167973563"

cd "$W1"

echo "== warp 1 m -> UTM 12N @ ${RES} m on the locked grid =="
gdalwarp -t_srs EPSG:32612 -te $TE -tr $RES $RES -r bilinear -multi \
  -co BIGTIFF=YES -co TILED=YES -co COMPRESS=DEFLATE -ot Float32 \
  -overwrite raw_dem_1m.vrt dem_1m_utm.tif

echo "== upsample the 10 m DEM to the same grid (void filler) =="
gdalwarp -t_srs EPSG:32612 -te $TE -tr $RES $RES -r bilinear -multi \
  -co BIGTIFF=YES -co TILED=YES -co COMPRESS=DEFLATE -ot Float32 \
  -overwrite "$PIPE/work/dem_filled.tif" dem_10m_up.tif

echo "== merge: 1 m where present, else 10 m =="
gdal_calc.py -A dem_1m_utm.tif -B dem_10m_up.tif --outfile=dem_merged.tif \
  --calc="where((A>-100000)&(A<9000),A,B)" --NoDataValue=none \
  --co BIGTIFF=YES --co TILED=YES --co COMPRESS=DEFLATE --overwrite

echo "== tile pyramid (z0..7, heights downsampled in height space) =="
# build into a staging dir and swap at the end — the live page keeps serving the old
# pyramid until the new one is complete (a mid-bake reload must never break the app)
rm -rf "$OUT/tiles.new"
"$PY" "$PIPE/tile_pyramid.py" dem_merged.tif "$OUT/tiles.new"

echo "== manifest + atomic swap =="
"$PY" "$PIPE/make_manifest.py" --dem dem_merged.tif --tiles "$OUT/tiles.new" \
  --tilesize 512 --dataset "USGS1m+10m" --res $RES --out "$OUT/tiles.json.new"
rm -rf "$OUT/tiles.old"
[ -d "$OUT/tiles" ] && mv "$OUT/tiles" "$OUT/tiles.old"
mv "$OUT/tiles.new" "$OUT/tiles"
mv "$OUT/tiles.json.new" "$OUT/tiles.json"
rm -rf "$OUT/tiles.old"

echo "Done. Reload the page — heights are now lidar-grade near the ground."
