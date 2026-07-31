#!/usr/bin/env python3
"""Build terrain/public/labels.json from USGS GNIS Domestic Names (WY).

Curated place-name labels in Grand Teton world coordinates.

World frame (from terrain/public/tiles.json):
  EPSG:32612 (UTM 12N)
  world x = easting  - centerEasting
  world z = centerNorthing - northing      (north => negative z)
  world y = ASL_meters - world.datum        (datum-relative; not written here)

No external deps required beyond stdlib. UTM 12N forward conversion is
hand-rolled (Snyder / USGS series). GDAL is used *only if available* to
sample real summit elevations from the baked DEM; otherwise ele = null.
"""
import csv
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))          # terrain/
GNIS = os.path.join(ROOT, "pipeline", "data", "gnis",
                    "DomesticNames_WY_Text", "Text", "DomesticNames_WY.txt")
TILES = os.path.join(ROOT, "public", "tiles.json")
DEM = os.path.join(ROOT, "pipeline", "work", "dem_filled.tif")
OUT = os.path.join(ROOT, "public", "labels.json")

MAX_LABELS = 150
DEDUPE_M = 500.0

# ---------------------------------------------------------------- world frame
with open(TILES) as fh:
    tj = json.load(fh)
W = tj["world"]
CEN_E = W["centerEasting"]
CEN_N = W["centerNorthing"]
gt = tj["geoTransform"]
px = gt[1]
py = -gt[5]
# terrain extent in UTM
E_MIN = gt[0]
E_MAX = gt[0] + tj["width"] * px
N_MAX = gt[3]
N_MIN = gt[3] - tj["height"] * py


# ------------------------------------------------------------- UTM 12N forward
def ll_to_utm12n(lat, lon):
    a = 6378137.0
    f = 1.0 / 298.257223563
    k0 = 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    lon0 = math.radians(-111.0)          # UTM zone 12 central meridian
    latr = math.radians(lat)
    lonr = math.radians(lon)
    N = a / math.sqrt(1 - e2 * math.sin(latr) ** 2)
    T = math.tan(latr) ** 2
    C = ep2 * math.cos(latr) ** 2
    A = (lonr - lon0) * math.cos(latr)
    M = a * (
        (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * latr
        - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * math.sin(2 * latr)
        + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * math.sin(4 * latr)
        - (35 * e2 ** 3 / 3072) * math.sin(6 * latr)
    )
    E = 500000.0 + k0 * N * (
        A + (1 - T + C) * A ** 3 / 6
        + (5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5 / 120
    )
    Nn = k0 * (
        M + N * math.tan(latr) * (
            A ** 2 / 2
            + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24
            + (61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6 / 720
        )
    )
    return E, Nn


def to_world(lat, lon):
    E, Nn = ll_to_utm12n(lat, lon)
    return (E - CEN_E), (CEN_N - Nn)


# ------------------------------------------------------- optional DEM sampler
class DemSampler:
    def __init__(self, path):
        self.ok = False
        try:
            from osgeo import gdal
        except Exception:
            return
        if not os.path.exists(path):
            return
        ds = gdal.Open(path)
        if ds is None:
            return
        self.g = ds.GetGeoTransform()
        self.band = ds.GetRasterBand(1)
        self.nd = self.band.GetNoDataValue()
        self.W = ds.RasterXSize
        self.H = ds.RasterYSize
        self.ds = ds
        self.ok = True

    def elev(self, easting, northing):
        if not self.ok:
            return None
        g = self.g
        col = int((easting - g[0]) / g[1])
        row = int((northing - g[3]) / g[5])
        if not (0 <= col < self.W and 0 <= row < self.H):
            return None
        try:
            v = self.band.ReadAsArray(col, row, 1, 1)
        except Exception:
            return None
        if v is None:
            return None
        val = float(v[0][0])
        if self.nd is not None and val == self.nd:
            return None
        if val < -1000 or val > 9000:
            return None
        return round(val, 1)


# --------------------------------------------------------------- icon lists
# imp = 1 : the icons. Matched by (normalized) exact name.
ICON_NAMES = {
    "grand teton", "middle teton", "south teton", "mount owen", "mount moran",
    "teewinot mountain", "nez perce peak", "buck mountain", "static peak",
    "mount saint john", "mount wister", "rockchuck peak", "symmetry spire",
    "jackson lake", "jenny lake", "leigh lake", "string lake", "phelps lake",
    "taggart lake", "bradley lake", "two ocean lake", "emma matilda lake",
    "snake river", "cascade canyon", "death canyon", "paintbrush canyon",
    "signal mountain", "moose", "kelly", "moran", "wilson", "jackson",
}
# summits at/above this elevation are promoted to imp 1
ICON_SUMMIT_ELE = 3400.0

# streams: only these major named runs are kept
STREAM_KEEP = {
    "snake river", "cottonwood creek", "pacific creek", "buffalo fork",
    "gros ventre river", "ditch creek", "spread creek", "cache creek",
    "flat creek", "bar bc creek",
}

# explicitly-kept famous locales (matched by name, any GNIS class)
LOCALE_NAMES = {
    "oxbow bend": "locale",
    "jackson lake dam": "locale",
    "mormon row": "locale",
    "schwabacher landing": "locale",
    "menors ferry": "locale",
    "chapel of the transfiguration": "locale",
}


# Curated coordinate overrides for features whose GNIS *primary point* is
# unusable inside this extent. GNIS records a stream's primary point at its
# MOUTH: "Snake River" resolves to 46.19N,-119.03W (Washington), far outside
# the park. We anchor it at a representative in-park river location instead
# (the Snake near the Moose crossing, on the valley floor ~1970 m).
CURATED_LATLON = {
    "snake river": (43.66, -110.710),
}


def norm(s):
    return re.sub(r"\s+", " ", s.strip().lower())


# --------------------------------------------------------------- class map
def classify(name, fclass):
    n = norm(name)
    if n in LOCALE_NAMES:
        return LOCALE_NAMES[n]
    fc = fclass
    if fc == "Summit":
        return "summit"
    if fc in ("Lake", "Reservoir"):
        return "lake"
    if fc == "Glacier":
        return "glacier"
    if fc == "Falls":
        return "falls"
    if fc == "Gap":
        return "pass"
    if fc == "Populated Place":
        return "place"
    if fc == "Stream":
        return "stream" if n in STREAM_KEEP else None
    if fc == "Valley":
        # GNIS files Grand Teton's canyons as "Valley"; keep only true canyons
        return "canyon" if "canyon" in n else None
    return None


# ------------------------------------------------------------------- parse
dem = DemSampler(DEM)
raw = []
with open(GNIS, encoding="utf-8-sig") as fh:
    rdr = csv.DictReader(fh, delimiter="|")
    for row in rdr:
        try:
            lat = float(row["prim_lat_dec"])
            lon = float(row["prim_long_dec"])
        except (TypeError, ValueError):
            continue
        ov = CURATED_LATLON.get(norm(row["feature_name"]))
        if ov is not None:
            lat, lon = ov
        E, Nn = ll_to_utm12n(lat, lon)
        # keep inside terrain extent (with tiny margin)
        if not (E_MIN - 200 <= E <= E_MAX + 200):
            continue
        if not (N_MIN - 200 <= Nn <= N_MAX + 200):
            continue
        name = row["feature_name"]
        cls = classify(name, row["feature_class"])
        if cls is None:
            continue
        x = E - CEN_E
        z = CEN_N - Nn
        ele = dem.elev(E, Nn)
        raw.append({
            "name": name, "cls": cls, "x": x, "z": z, "ele": ele,
            "_n": norm(name),
        })

# ------------------------------------------------------------- importance
counts = {}


def importance(rec):
    n = rec["_n"]
    cls = rec["cls"]
    if n in ICON_NAMES:
        return 1
    if cls == "summit" and rec["ele"] is not None and rec["ele"] >= ICON_SUMMIT_ELE:
        return 1
    if cls in ("lake",) and n in ICON_NAMES:
        return 1
    if cls == "place":
        return 1
    if cls in ("canyon", "glacier", "pass"):
        return 2
    if cls == "summit":
        return 2 if (rec["ele"] is not None and rec["ele"] >= 3000) else 3
    if cls == "lake":
        return 2
    if cls == "stream":
        return 1 if n == "snake river" else 2
    if cls == "falls":
        return 2
    if cls == "locale":
        return 2
    return 3


for r in raw:
    r["imp"] = importance(r)

# ------------------------------------------------------------- dedupe
raw.sort(key=lambda r: (r["imp"], r["_n"]))
kept = []
for r in raw:
    dup = False
    for k in kept:
        if k["_n"] == r["_n"]:
            d = math.hypot(k["x"] - r["x"], k["z"] - r["z"])
            if d < DEDUPE_M:
                dup = True
                break
    if not dup:
        kept.append(r)

# cap at MAX_LABELS preferring higher importance (already imp-sorted)
kept = kept[:MAX_LABELS]

# final sort: imp then name
kept.sort(key=lambda r: (r["imp"], r["_n"]))

labels = [{
    "name": r["name"],
    "x": round(r["x"], 1),
    "z": round(r["z"], 1),
    "cls": r["cls"],
    "ele": r["ele"],
    "imp": r["imp"],
} for r in kept]

with open(OUT, "w") as fh:
    json.dump({"labels": labels}, fh, separators=(",", ":"))
    fh.write("\n")

# ------------------------------------------------------------- report
for r in kept:
    counts[r["cls"]] = counts.get(r["cls"], 0) + 1
print("DEM elevation sampling:", "ON" if dem.ok else "OFF (ele=null)")
print("counts per class:")
for c in sorted(counts):
    print(f"  {c:8s} {counts[c]}")
print("total kept:", len(kept))
imp_counts = {}
for r in kept:
    imp_counts[r["imp"]] = imp_counts.get(r["imp"], 0) + 1
print("per importance:", {k: imp_counts[k] for k in sorted(imp_counts)})

print("\n10 spot checks (name / world x / world z / ele):")
spot = ["grand teton", "mount moran", "jackson lake", "jenny lake",
        "snake river", "middle teton", "south teton", "mount owen",
        "cascade canyon", "signal mountain"]
byname = {r["_n"]: r for r in kept}
for nm in spot:
    r = byname.get(nm)
    if r:
        el = f"{r['ele']:.0f}m" if r["ele"] is not None else "null"
        print(f"  {r['name']:20s} x={r['x']:9.1f}  z={r['z']:9.1f}  ele={el}")
    else:
        print(f"  {nm:20s} (not in output)")
