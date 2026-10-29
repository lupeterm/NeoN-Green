#!/usr/bin/env python3
"""Road traffic noise (EU noise mapping 2022, Lden) for Heilbronn as a point grid (stdlib only).

    python3 scripts/prepare_noise.py      # writes data/noise_road_lden.csv

Source: Umweltbundesamt, Lärmkartierung Deutschland (data of Stadt Heilbronn), ArcGIS REST
service VeLa/LK, layer 4210 "roads inside agglomerations, Lden", features 110600001-5 =
agglomeration Heilbronn. The service delivers one multipolygon per 5 dB band; this script
samples them on a grid (each point gets the band's middle value, e.g. 55-59 dB -> 57) so the
map can interpolate noise like any other point data. Areas below 55 dB are not mapped by the
EU directive and get no points.
"""
import csv
import json
import math
import pathlib
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "noise_road_lden.csv"
SERVICE = "https://datahub.uba.de/server/rest/services/VeLa/LK/MapServer/4210/query"
CELL_M = 25
BANDS = {"Lden5559": 57, "Lden6064": 62, "Lden6569": 67, "Lden7074": 72, "LdenGreaterThan75": 77}


def fetch():
    q = urllib.parse.urlencode({"where": "id >= 110600001 AND id <= 110600005", "outSR": 4326,
                                "outFields": "id,Lärmpegelklasse", "geometryPrecision": 6, "f": "geojson"})
    req = urllib.request.Request(f"{SERVICE}?{q}", headers={"User-Agent": "NeoN-Green data preparation"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def main():
    gj = fetch()
    rings_by_value = {}
    for f in gj["features"]:
        value = BANDS[f["properties"]["Lärmpegelklasse"]]
        polys = f["geometry"]["coordinates"] if f["geometry"]["type"] == "MultiPolygon" else [f["geometry"]["coordinates"]]
        rings_by_value[value] = [ring for poly in polys for ring in poly]

    all_pts = [p for rings in rings_by_value.values() for ring in rings for p in ring]
    lon0 = sum(p[0] for p in all_pts) / len(all_pts)
    lat0 = sum(p[1] for p in all_pts) / len(all_pts)
    kx, ky = 111320 * math.cos(math.radians(lat0)), 111320
    w, e = min(p[0] for p in all_pts), max(p[0] for p in all_pts)
    s, n = min(p[1] for p in all_pts), max(p[1] for p in all_pts)
    cols, rows = int((e - w) * kx / CELL_M) + 1, int((n - s) * ky / CELL_M) + 1
    dlon, dlat = CELL_M / kx, CELL_M / ky

    grid = {}  # (row, col) -> value; bands are disjoint, but keep the loudest if they touch
    for value, rings in rings_by_value.items():
        # edges in grid units, then an even-odd scanline fill through the cell centres
        edges = []
        for ring in rings:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                edges.append(((x1 - w) / dlon, (y1 - s) / dlat, (x2 - w) / dlon, (y2 - s) / dlat))
        by_row = {}
        for x1, y1, x2, y2 in edges:
            if y1 == y2:
                continue
            lo, hi = sorted((y1, y2))
            for r in range(math.ceil(lo - 0.5), math.floor(hi - 0.5) + 1):
                yc = r + 0.5
                if lo <= yc < hi:
                    by_row.setdefault(r, []).append(x1 + (yc - y1) * (x2 - x1) / (y2 - y1))
        for r, xs in by_row.items():
            xs.sort()
            for a, b in zip(xs[0::2], xs[1::2]):
                for c in range(math.ceil(a - 0.5), math.floor(b - 0.5) + 1):
                    if grid.get((r, c), 0) < value:
                        grid[(r, c)] = value

    OUT.parent.mkdir(exist_ok=True)
    with open(OUT, "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["lon", "lat", "lden"])
        for (r, c), value in sorted(grid.items()):
            wr.writerow([round(w + (c + 0.5) * dlon, 5), round(s + (r + 0.5) * dlat, 5), value])
    counts = {v: sum(1 for x in grid.values() if x == v) for v in sorted(BANDS.values())}
    print(f"{OUT.relative_to(ROOT)}: {len(grid)} points on a {CELL_M} m grid, per band {counts}, "
          f"{OUT.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
