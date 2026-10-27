#!/usr/bin/env python3
"""Fetch ATRAI bike measurements for Heilbronn from openSenseMap (stdlib only).

    python3 scripts/fetch_atrai.py                                  # last 7 days
    python3 scripts/fetch_atrai.py --from 2026-06-01 --to 2026-06-30

ATRAI bikes are openSenseMap boxes with the grouptag "heilbronn". Their data
lies in the openSenseMap archive as one CSV per sensor and day, each row with
its own GPS fix; readings sharing a timestamp are merged into one row (same
approach as github.com/reedu-reengineering-education/atrai-bikes-ingestor).
Points outside the bounding box of Heilbronn's districts are dropped.
"""
import argparse
import concurrent.futures
import csv
import datetime as dt
import io
import json
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
BERLIN = ZoneInfo("Europe/Berlin")
HN_BBOX = (49.0929, 49.2099, 9.0444, 9.3021)  # lat0, lat1, lon0, lon1 of the city districts

OSM_API = "https://api.opensensemap.org"
OSM_ARCHIVE = "https://archive.opensensemap.org"

SENSORS = {  # openSenseMap sensor title -> column; units: µg/m³, °C, %, m/s
    "Finedust PM1": "pm1", "Finedust PM2.5": "pm25", "Finedust PM10": "pm10",
    "Temperature": "temperatur", "Rel. Humidity": "luftfeuchte", "Speed": "speed",
}
VALID = {"pm1": (0, 1000), "pm25": (0, 1000), "pm10": (0, 1000),
         "temperatur": (-30, 60), "luftfeuchte": (0, 100), "speed": (0, 30)}
FIELDS = ["zeit", "box", "lat", "lon", "pm25", "pm10", "pm1", "temperatur", "luftfeuchte", "tempo_kmh"]


def get(url, timeout=120, tries=3):
    """GET a URL; None on 404 (no archive for that day), retry on other errors."""
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt == tries - 1:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == tries - 1:
                raise
        time.sleep(2 ** attempt)


def fnum(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def boxes(grouptag, day_from):
    """Boxes of the campaign that have reported anything since day_from."""
    q = urllib.parse.urlencode({"grouptag": grouptag})
    out = []
    for b in json.loads(get(f"{OSM_API}/boxes?{q}")):
        last = b.get("lastMeasurementAt")
        if last and last[:10] >= day_from.isoformat():
            out.append((b["_id"], b["name"]))
    return out


def box_day(box_id, name, day):
    """All merged measurements of one box on one day, keyed by timestamp."""
    folder = f"{OSM_ARCHIVE}/{day}/{box_id}-{re.sub(r'[^A-Za-z0-9._-]', '_', name)}"
    meta = get(f"{folder}/{re.sub(r'[^A-Za-z0-9._-]', '_', name)}-{day}.json")
    if meta is None:
        return {}
    rows = {}
    for s in json.loads(meta).get("sensors", []):
        col = SENSORS.get(s.get("title", "").strip())
        if not col:
            continue
        body = get(f"{folder}/{s['_id']}-{day}.csv")
        if body is None:
            continue
        for r in csv.DictReader(io.StringIO(body.decode())):
            t = r.get("createdAt")
            row = rows.setdefault(t, {"t": t, "box": name})
            lat, lon = fnum(r.get("latitude")), fnum(r.get("longitude"))
            if lat is not None and lon is not None:
                row["lat"], row["lon"] = lat, lon
            row[col] = fnum(r.get("value"))
    return rows


def clean(rows, bbox):
    lat0, lat1, lon0, lon1 = bbox
    out = []
    for r in rows:
        if not (lat0 <= r.get("lat", -999) <= lat1 and lon0 <= r.get("lon", -999) <= lon1):
            continue
        for col, (lo, hi) in VALID.items():
            if r.get(col) is not None and not lo <= r[col] <= hi:
                r[col] = None
        if r.get("pm25") is None and r.get("temperatur") is None:
            continue
        t = dt.datetime.fromisoformat(r["t"].replace("Z", "+00:00")).astimezone(BERLIN)
        out.append({"zeit": t.strftime("%Y-%m-%d %H:%M:%S"), "box": r["box"],
                    "lat": round(r["lat"], 6), "lon": round(r["lon"], 6),
                    "pm25": r.get("pm25"), "pm10": r.get("pm10"), "pm1": r.get("pm1"),
                    "temperatur": r.get("temperatur"), "luftfeuchte": r.get("luftfeuchte"),
                    "tempo_kmh": None if r.get("speed") is None else round(r["speed"] * 3.6, 1)})
    return sorted(out, key=lambda r: (r["box"], r["zeit"]))


def main():
    yesterday = dt.date.today() - dt.timedelta(days=1)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="day_from", type=dt.date.fromisoformat, default=yesterday - dt.timedelta(days=6))
    ap.add_argument("--to", dest="day_to", type=dt.date.fromisoformat, default=yesterday)
    ap.add_argument("--grouptag", default="heilbronn")
    ap.add_argument("--out", type=pathlib.Path, default=DATA / "atrai_bike.csv")
    a = ap.parse_args()

    bxs = boxes(a.grouptag, a.day_from)
    days = [a.day_from + dt.timedelta(days=i) for i in range((a.day_to - a.day_from).days + 1)]
    print(f"atrai: {len(bxs)} '{a.grouptag}' boxes active since {a.day_from}, {len(days)} days")

    rows = []
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        jobs = {pool.submit(box_day, bid, name, d): (name, d) for bid, name in bxs for d in days}
        for job in concurrent.futures.as_completed(jobs):
            name, d = jobs[job]
            try:
                got = job.result()
            except Exception as e:
                print(f"  ! {name} {d}: {e}")
                continue
            if got:
                print(f"  {d} {name}: {len(got)} timestamps")
            rows.extend(got.values())

    out = clean(rows, HN_BBOX)
    with a.out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for r in out:
            w.writerow({k: ("" if r[k] is None else r[k]) for k in FIELDS})
    print(f"  {a.out.relative_to(ROOT) if a.out.is_relative_to(ROOT) else a.out}  {len(out)} rows "
          f"from {len({r['box'] for r in out})} boxes ({len(rows) - len(out)} dropped)")


if __name__ == "__main__":
    main()
