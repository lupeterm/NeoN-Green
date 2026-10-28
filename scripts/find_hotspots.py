#!/usr/bin/env python3
"""Find heat hotspots in senseBox:bike measurements (stdlib only).

    python3 scripts/find_hotspots.py                         # uses data/atrai_bike.csv
    python3 scripts/find_hotspots.py atrai_jun_oct.csv --top 5

Air temperature changes over the day and between days, so absolute values of
different rides cannot be compared. Each reading is therefore taken relative to
the median of its own ride: +1.5 °C means "1.5 °C warmer than the rest of that
ride". These anomalies are averaged in grid cells, first per ride and then over
rides, so a frequent rider counts once per ride, not once per reading. Cells
are ranked by mean minus standard error, so a cell crossed by a few rides with
scattered values does not beat one that is reliably warm.

Bikes often use tracks, paths and service roads, but trees are planted along
streets. A cell only counts if Nominatim finds a street (STREET_TYPES) within
MAX_STREET_DIST_M; the hotspot is then moved onto that street. The best cells,
at least --min-dist apart and on different streets, go to data/hotspots.geojson.
"""
import argparse
import csv
import datetime as dt
import json
import math
import pathlib
import statistics
import time
import urllib.parse
import urllib.request
from collections import defaultdict

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
NOMINATIM = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "NeoN-Green hotspot finder (github.com/lupeterm/NeoN-Green)"

RIDE_GAP_MIN = 10      # a pause longer than this starts a new ride
WARMUP_MIN = 3         # the box adapts to outside air after leaving the house
MIN_RIDE_MIN = 10
MIN_SPEED_KMH = 5      # standing at lights heats the unventilated sensor
STREET_TYPES = {"primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "pedestrian"}
MAX_STREET_DIST_M = 25


def reverse(lat, lon):
    q = urllib.parse.urlencode({"format": "jsonv2", "lat": lat, "lon": lon, "zoom": 17, "layer": "address",
                                "polygon_geojson": 1})
    req = urllib.request.Request(f"{NOMINATIM}?{q}", headers={"User-Agent": USER_AGENT})
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except (OSError, ValueError):
            time.sleep(5)
        finally:
            time.sleep(1.1)  # Nominatim usage policy: max 1 request per second
    return {}


def nearest_street(lat, lon, mx, my):
    """(name, lat, lon) of the closest point on a street within MAX_STREET_DIST_M, else None."""
    d = reverse(lat, lon)
    if d.get("category") != "highway" or d.get("type") not in STREET_TYPES or not d.get("name"):
        return None
    g = d.get("geojson") or {}
    lines = {"LineString": [g.get("coordinates")], "MultiLineString": g.get("coordinates")}.get(g.get("type"), [])
    px, py, best = lon * mx, lat * my, None
    for line in lines:
        for (x0, y0), (x1, y1) in zip(line, line[1:]):
            ax, ay, dx, dy = x0 * mx, y0 * my, (x1 - x0) * mx, (y1 - y0) * my
            t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / ((dx * dx + dy * dy) or 1)))
            qx, qy = ax + t * dx, ay + t * dy
            if best is None or math.hypot(px - qx, py - qy) < best[0]:
                best = (math.hypot(px - qx, py - qy), qy / my, qx / mx)
    if best is None or best[0] > MAX_STREET_DIST_M:
        return None
    return d["name"], best[1], best[2]


def rides(path):
    """Readings grouped into rides, warm-up and stops removed: [(box, [(t, lat, lon, temp), ...]), ...]"""
    by_box = defaultdict(list)
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            if not r["temperatur"] or not r["tempo_kmh"] or float(r["tempo_kmh"]) < MIN_SPEED_KMH:
                continue
            t = dt.datetime.fromisoformat(r["zeit"])
            by_box[r["box"]].append((t, float(r["lat"]), float(r["lon"]), float(r["temperatur"])))
    out = []
    for box, pts in by_box.items():
        pts.sort()
        ride = [pts[0]]
        for p in pts[1:] + [None]:
            if p and (p[0] - ride[-1][0]).total_seconds() <= RIDE_GAP_MIN * 60:
                ride.append(p)
                continue
            start, end = ride[0][0], ride[-1][0]
            if (end - start).total_seconds() >= MIN_RIDE_MIN * 60:
                out.append((box, [x for x in ride if (x[0] - start).total_seconds() >= WARMUP_MIN * 60]))
            ride = [p] if p else []
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", nargs="?", type=pathlib.Path, default=DATA / "atrai_bike.csv",
                    help="output of scripts/fetch_atrai.py")
    ap.add_argument("--top", type=int, default=5)
    ap.add_argument("--cell", type=float, default=100, help="grid cell size in m")
    ap.add_argument("--min-rides", type=int, default=8, help="rides needed through a cell")
    ap.add_argument("--min-bikes", type=int, default=2, help="different bikes needed through a cell")
    ap.add_argument("--min-dist", type=float, default=300, help="minimum distance between hotspots in m")
    ap.add_argument("--max-lookups", type=int, default=150, help="Nominatim requests at most (1 per second)")
    ap.add_argument("--out", type=pathlib.Path, default=DATA / "hotspots.geojson")
    a = ap.parse_args()

    rs = rides(a.csv)
    lat0 = statistics.median(p[1] for _, r in rs for p in r)
    mx, my = 111320 * math.cos(math.radians(lat0)), 110540  # metres per degree

    # cell -> ride -> [anomaly], plus everything needed to describe the cell
    cells = defaultdict(lambda: defaultdict(list))
    where = defaultdict(list)
    days = set()
    for i, (_, ride) in enumerate(rs):
        med = statistics.median(p[3] for p in ride)
        for t, lat, lon, temp in ride:
            c = (math.floor(lon * mx / a.cell), math.floor(lat * my / a.cell))
            cells[c][i].append(temp - med)
            where[c].append((lat, lon, temp))
            days.add(t.date())

    ranked = []
    for c, per_ride in cells.items():
        if len(per_ride) < a.min_rides or len({rs[i][0] for i in per_ride}) < a.min_bikes:
            continue
        means = [statistics.fmean(v) for v in per_ride.values()]
        pts = where[c]
        clat, clon = statistics.fmean(p[0] for p in pts), statistics.fmean(p[1] for p in pts)
        lat, lon, _ = min(pts, key=lambda p: math.hypot((p[1] - clon) * mx, (p[0] - clat) * my))  # on the road
        ranked.append({
            "anomaly": statistics.fmean(means), "se": statistics.stdev(means) / math.sqrt(len(means)),
            "rides": len(means), "boxes": len({rs[i][0] for i in per_ride}), "points": len(pts),
            "lat": lat, "lon": lon,
            "temp": statistics.fmean(p[2] for p in pts)})
    ranked.sort(key=lambda x: x["se"] - x["anomaly"])
    print(f"hotspots: {len(rs)} rides on {len(days)} days, {len(ranked)} of {len(cells)} cells with >= {a.min_rides} rides by >= {a.min_bikes} bikes")

    picked, lookups = [], 0
    for h in ranked:
        if len(picked) == a.top or lookups == a.max_lookups:
            break
        if any(math.hypot((h["lon"] - p["lon"]) * mx, (h["lat"] - p["lat"]) * my) < a.min_dist for p in picked):
            continue
        lookups += 1
        street = nearest_street(h["lat"], h["lon"], mx, my)
        if not street or street[0] in {p["name"] for p in picked}:
            continue
        h["name"], h["lat"], h["lon"] = street
        picked.append(h)
        print(f"  {len(picked)}. {h['name']:<28} {h['anomaly']:+.2f} ± {h['se']:.2f} °C  "
              f"{h['rides']} rides, {h['boxes']} bikes, Ø {h['temp']:.1f} °C")

    feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(h["lon"], 6), round(h["lat"], 6)]},
              "properties": {"rang": k, "strasse": h["name"], "anomalie_K": round(h["anomaly"], 2),
                             "fehler_K": round(h["se"], 2), "fahrten": h["rides"], "raeder": h["boxes"],
                             "messwerte": h["points"], "temperatur_mittel": round(h["temp"], 1)}}
             for k, h in enumerate(picked, 1)]
    meta = {"quelle": "openSenseMap, grouptag heilbronn (senseBox:bike)", "von": str(min(days)), "bis": str(max(days)),
            "methode": f"Abweichung vom Fahrtmedian, {a.cell:.0f}-m-Raster, mind. {a.min_rides} Fahrten von {a.min_bikes} Rädern"}
    a.out.write_text(json.dumps({"type": "FeatureCollection", "meta": meta, "features": feats}, ensure_ascii=False, indent=1) + "\n")
    print(f"  {a.out.relative_to(ROOT) if a.out.is_relative_to(ROOT) else a.out}  {len(feats)} hotspots "
          f"({lookups} cells checked for a street)")


if __name__ == "__main__":
    main()
