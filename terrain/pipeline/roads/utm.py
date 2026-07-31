"""WGS84 lat/lon -> UTM zone 12N (EPSG:32612), hand-rolled Karney/Krueger series.

No GDAL/pyproj dependency. Accuracy ~1 mm inside the zone, plenty for road baking.
"""
import math

# WGS84
_A = 6378137.0
_F = 1.0 / 298.257223563
_K0 = 0.9996
_E0 = 500000.0
_LON0 = math.radians(-111.0)  # zone 12N central meridian

_N = _F / (2.0 - _F)
_n = _N
_AA = _A / (1.0 + _n) * (1.0 + _n**2 / 4.0 + _n**4 / 64.0 + _n**6 / 256.0)
_ALPHA = (
  _n / 2 - 2 * _n**2 / 3 + 5 * _n**3 / 16 + 41 * _n**4 / 180 - 127 * _n**5 / 288 + 7891 * _n**6 / 37800,
  13 * _n**2 / 48 - 3 * _n**3 / 5 + 557 * _n**4 / 1440 + 281 * _n**5 / 630 - 1983433 * _n**6 / 1935360,
  61 * _n**3 / 240 - 103 * _n**4 / 140 + 15061 * _n**5 / 26880 + 167603 * _n**6 / 181440,
  49561 * _n**4 / 161280 - 179 * _n**5 / 168 + 6601661 * _n**6 / 7257600,
  34729 * _n**5 / 80640 - 3418889 * _n**6 / 1995840,
  212378941 * _n**6 / 319334400,
)


def wgs84_to_utm12(lat_deg, lon_deg):
  """Return (easting, northing) meters in EPSG:32612."""
  phi = math.radians(lat_deg)
  lam = math.radians(lon_deg) - _LON0
  sphi = math.sin(phi)
  t = math.sinh(math.atanh(sphi) - 2 * math.sqrt(_n) / (1 + _n) * math.atanh(2 * math.sqrt(_n) / (1 + _n) * sphi))
  xip = math.atan2(t, math.cos(lam))
  etap = math.asinh(math.sin(lam) / math.hypot(t, math.cos(lam)))
  xi = xip
  eta = etap
  for j, a in enumerate(_ALPHA, start=1):
    xi += a * math.sin(2 * j * xip) * math.cosh(2 * j * etap)
    eta += a * math.cos(2 * j * xip) * math.sinh(2 * j * etap)
  easting = _E0 + _K0 * _AA * eta
  northing = _K0 * _AA * xi
  return easting, northing


if __name__ == '__main__':
  # Sanity: Grand Teton summit 43.741 N, -110.802 E. Reference values verified
  # against an independent Snyder-formula implementation (agreement < 1 mm).
  e, n = wgs84_to_utm12(43.741, -110.802)
  print('Grand Teton summit -> E %.1f  N %.1f' % (e, n))
  assert abs(e - 515943.37) < 0.01 and abs(n - 4843125.98) < 0.01, 'UTM converter off'
  print('OK')
