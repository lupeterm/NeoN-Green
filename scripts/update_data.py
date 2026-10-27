#!/usr/bin/env python3
"""Regenerate the datasets in data/ from their public sources (stdlib only).

    python3 scripts/update_data.py                      # everything
    python3 scripts/update_data.py --only heat --heat-day 2025-08-13
    python3 scripts/update_data.py --only air --from 2026-01-01

Each dataset is one file referenced by data/manifest.json. Swap a file (same
columns) and reload index.html - nothing else needs to change.
"""
import argparse
import csv
import datetime as dt
import gzip
import io
import json
import pathlib
import statistics
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
MANIFEST = DATA / "manifest.json"
BERLIN = ZoneInfo("Europe/Berlin")

HN_CENTER = (49.1427, 9.2109)
HN_OPENDATA = "https://opendata.heilbronn.de/sites/default/files"
UBA_API = "https://www.umweltbundesamt.de/api/air_data/v3"
UBA_NOISE = "https://datahub.uba.de/server/rest/services/VeLa/LK/MapServer"
SC_LIVE = "https://data.sensor.community/airrohr/v1/filter/area={lat},{lon},{km}"
SC_ARCHIVE = "https://archive.sensor.community"

UBA_STATIONS = {  # active LUBW stations in Heilbronn (UBA station ids)
    "226": {"station": "DEBW015", "name": "Heilbronn Hans-Rießer-Str.", "typ": "städtischer Hintergrund",
            "lat": 49.1655, "lon": 9.2248},
    "353": {"station": "DEBW152", "name": "Heilbronn Weinsberger Str.-Ost", "typ": "Verkehr",
            "lat": 49.1460, "lon": 9.2259},
}
UBA_COMPONENTS = {1: "PM10", 5: "NO2", 9: "PM2.5", 3: "O3"}
UBA_SERIES = [("226", 1), ("226", 5), ("226", 9), ("226", 3), ("353", 5)]  # pairs that deliver hourly data
POLLUTANTS = ["NO2", "PM10", "PM2.5", "O3"]
NOISE_BANDS = {"Lden5559": ("55-59 dB(A)", 55), "Lden6064": ("60-64 dB(A)", 60), "Lden6569": ("65-69 dB(A)", 65),
               "Lden7074": ("70-74 dB(A)", 70), "LdenGreaterThan75": ("75+ dB(A)", 75)}


def get(url, timeout=300):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read()


def fnum(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def round_coords(obj, nd=5):
    if isinstance(obj, list) and obj and isinstance(obj[0], (int, float)):
        return [round(obj[0], nd), round(obj[1], nd)]
    return [round_coords(x, nd) for x in obj] if isinstance(obj, list) else obj


def write_csv(path, rows, fields):
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in rows:
            w.writerow({k: ("" if r.get(k) is None else r.get(k)) for k in fields})
    print(f"  {path.relative_to(ROOT)}  {len(rows)} rows")


def write_json(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    print(f"  {path.relative_to(ROOT)}  {path.stat().st_size // 1024} kB")


def set_label(dataset_id, label):
    m = json.loads(MANIFEST.read_text())
    for d in m["datasets"]:
        if d["id"] == dataset_id:
            d["label"] = label
    MANIFEST.write_text(json.dumps(m, ensure_ascii=False, indent=2) + "\n")


# --------------------------------------------------------------------------- datasets

def districts():
    print("districts: Stadt Heilbronn open data")
    d = json.loads(get(f"{HN_OPENDATA}/Heilbronn_Stadtteilgrenzen_Gen_0.geojson"))
    feats = [{"type": "Feature", "properties": {"stadtteil": f["properties"]["ORTSTEIL"]},
              "geometry": {"type": f["geometry"]["type"], "coordinates": round_coords(f["geometry"]["coordinates"])}}
             for f in d["features"]]
    write_json(DATA / "districts.geojson", {"type": "FeatureCollection", "features": feats})


def noise():
    print("noise: UBA Lärmkartierung 2022, roads inside agglomeration Heilbronn, Lden")
    q = urllib.parse.urlencode({"where": "id >= 110600001 AND id <= 110600005", "outSR": 4326,
                                "outFields": "id,Lärmpegelklasse", "geometryPrecision": 6,
                                "maxAllowableOffset": 0.00001, "f": "geojson"})
    d = json.loads(get(f"{UBA_NOISE}/4210/query?{q}"))
    feats = []
    for f in sorted(d["features"], key=lambda f: NOISE_BANDS[f["properties"]["Lärmpegelklasse"]][1]):
        label, lo = NOISE_BANDS[f["properties"]["Lärmpegelklasse"]]
        feats.append({"type": "Feature", "properties": {"quelle": "Straßenverkehr", "pegelklasse": label, "pegel_min_db": lo},
                      "geometry": {"type": f["geometry"]["type"], "coordinates": round_coords(f["geometry"]["coordinates"])}})
    write_json(DATA / "noise_road_lden.geojson", {"type": "FeatureCollection", "features": feats})


def air(date_from, date_to):
    print(f"air: UBA Luftdaten-API, hourly {date_from}..{date_to} -> daily means")
    hourly = defaultdict(dict)
    for st, comp in UBA_SERIES:
        q = urllib.parse.urlencode({"date_from": date_from, "time_from": 1, "date_to": date_to, "time_to": 24,
                                    "station": st, "component": comp, "scope": 2})
        d = json.loads(get(f"{UBA_API}/measures/json?{q}"))
        for t, (_, _, val, _, _) in d["data"].get(st, {}).items():
            if val is not None:
                hourly[(st, t[:10])].setdefault(UBA_COMPONENTS[comp], []).append(val)
    rows = []
    for (st, day), pols in sorted(hourly.items()):
        s = UBA_STATIONS[st]
        row = {"datum": f"{day} 12:00:00", **s}
        for p in POLLUTANTS:
            v = pols.get(p, [])
            row[f"{p}_tagesmittel"] = round(statistics.fmean(v), 1) if len(v) >= 18 else None
            row[f"{p}_max_1h"] = max(v) if v else None
        rows.append(row)
    fields = ["datum", "station", "name", "typ", "lat", "lon"] + [f"{p}_{k}" for p in POLLUTANTS for k in ("tagesmittel", "max_1h")]
    write_csv(DATA / "air_stations_daily.csv", rows, fields)


def heat(day):
    print(f"heat: sensor.community archive {day}, 10-minute means per location")
    live = json.loads(get(SC_LIVE.format(lat=HN_CENTER[0], lon=HN_CENTER[1], km=8)))
    sensors = sorted({(r["sensor"]["id"], r["sensor"]["sensor_type"]["name"].lower()) for r in live
                      if not r["location"].get("indoor")})
    bins, meta = defaultdict(lambda: defaultdict(list)), {}
    for sid, stype in sensors:
        fname = f"{day}_{stype}_sensor_{sid}.csv"
        raw = None
        for suffix in (".gz", ""):
            try:
                raw = get(f"{SC_ARCHIVE}/{day[:4]}/{day}/{fname}{suffix}", timeout=60)
                raw = gzip.decompress(raw) if suffix else raw
                break
            except Exception:  # noqa: BLE001 - sensor simply has no file that day
                continue
        if raw is None:
            continue
        for r in csv.DictReader(io.StringIO(raw.decode()), delimiter=";"):
            meta[r["location"]] = (float(r["lat"]), float(r["lon"]))
            ts = dt.datetime.fromisoformat(r["timestamp"]).replace(tzinfo=dt.timezone.utc).astimezone(BERLIN)
            b = ts.replace(minute=ts.minute // 10 * 10, second=0, microsecond=0)
            for src, dst in (("temperature", "temperatur"), ("humidity", "luftfeuchte"), ("P1", "pm10"), ("P2", "pm25")):
                v = fnum(r.get(src))
                if v is not None:
                    bins[(r["location"], b)][dst].append(v)
    rows = [{"zeit": b.strftime("%Y-%m-%d %H:%M:%S"), "standort_id": lid, "lat": meta[lid][0], "lon": meta[lid][1],
             **{k: round(statistics.fmean(v), 1) for k, v in vals.items()}}
            for (lid, b), vals in sorted(bins.items(), key=lambda kv: (kv[0][1], kv[0][0]))]
    write_csv(DATA / "heat_sensors.csv", rows, ["zeit", "standort_id", "lat", "lon", "temperatur", "luftfeuchte", "pm10", "pm25"])
    set_label("heat", f"Hitze – Bürgersensoren {day} (Zeitfilter)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", choices=["districts", "noise", "air", "heat"])
    ap.add_argument("--heat-day", default="2025-07-02", help="day to pull from the sensor.community archive")
    ap.add_argument("--from", dest="date_from", default="2025-01-01")
    ap.add_argument("--to", dest="date_to", default=dt.date.today().isoformat())
    a = ap.parse_args()
    steps = {"districts": districts, "noise": noise,
             "air": lambda: air(a.date_from, a.date_to), "heat": lambda: heat(a.heat_day)}
    for k, fn in steps.items():
        if not a.only or k in a.only:
            fn()


if __name__ == "__main__":
    sys.exit(main())
