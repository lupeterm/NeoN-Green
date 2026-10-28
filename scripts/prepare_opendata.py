#!/usr/bin/env python3
"""Turn the opendata.heilbronn.de mirror into map layers in data/ (stdlib only).

    python3 scripts/fetch_opendata.py      # mirror the portal's environment datasets into opendata/
    python3 scripts/prepare_opendata.py    # build data/*.geojson and data/*.json from it

Coordinates the portal does not provide come from OpenStreetMap: Nominatim for addresses and
named sites, Overpass for street geometry and the counting station's junction. Answers are
cached in opendata/_lookups.json, so re-running does not query the services again.
"""
import csv
import io
import json
import pathlib
import re
import struct
import time
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIRROR = ROOT / "opendata"
DATA = ROOT / "data"
CACHE = MIRROR / "_lookups.json"
UA = {"User-Agent": "NeoN-Green data preparation (github.com/lupeterm/NeoN-Green)"}
HN_AREA = 'area["name"="Heilbronn"]["boundary"="administrative"]["admin_level"="6"]->.a;'

_cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}


def cached(key, fn):
    if key not in _cache:
        _cache[key] = fn()
        CACHE.write_text(json.dumps(_cache, ensure_ascii=False, indent=1))
    return _cache[key]


def http(url, data=None, timeout=180):
    req = urllib.request.Request(url, data=data, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def overpass(query):
    body = urllib.parse.urlencode({"data": f"[out:json][timeout:180];{query}"}).encode()
    return cached("overpass:" + query, lambda: json.loads(http("https://overpass-api.de/api/interpreter", body, 300))["elements"])


def nominatim(q):
    def ask():
        time.sleep(1.1)  # usage policy: max. one request per second
        hits = json.loads(http("https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"format": "jsonv2", "limit": 1, "q": q})))
        return [float(hits[0]["lon"]), float(hits[0]["lat"]), hits[0]["display_name"]] if hits else None
    return cached("nominatim:" + q, ask)


def read_text(path):
    raw = pathlib.Path(path).read_bytes()
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass


def num(s):
    """German number: '2.400' -> 2400, '708,7' -> 708.7"""
    s = str(s).strip().replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def latest(folder, pattern):
    files = sorted((MIRROR / folder).glob(pattern))
    if not files:
        raise SystemExit(f"nothing matching {folder}/{pattern} in {MIRROR}; run scripts/fetch_opendata.py first")
    return files[-1]


def write(name, obj):
    path = DATA / name
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    print(f"  {path.relative_to(ROOT)}  {path.stat().st_size / 1e6:.2f} MB")


def point(lon, lat, props, digits=6):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, digits), round(lat, digits)]}, "properties": props}


# ----------------------------------------------------------------------------- trees

def trees():
    """Latest Baumkataster shapefile (WGS84) -> GeoJSON points."""
    src = latest("baumkataster", "SHAPE_BKA_HN*_EPSG4326.zip")
    z = zipfile.ZipFile(src)
    name = lambda ext: next(n for n in z.namelist() if n.lower().endswith(ext))
    shp, dbf = z.read(name(".shp")), z.read(name(".dbf"))
    enc = z.read(name(".cpg")).decode().strip() if any(n.lower().endswith(".cpg") for n in z.namelist()) else "latin1"
    enc = "utf-8" if enc.lower().replace("-", "") == "utf8" else enc

    n, hlen, rlen = struct.unpack("<IHH", dbf[4:12])
    fields, pos = [], 32
    while dbf[pos] != 0x0D:
        fields.append((dbf[pos:pos + 11].split(b"\0")[0].decode(), dbf[pos + 16]))
        pos += 32
    records = []
    for i in range(n):
        rec = dbf[hlen + i * rlen: hlen + (i + 1) * rlen]
        off, row = 1, {}
        for fname, flen in fields:
            row[fname] = rec[off:off + flen].decode(enc, "replace").strip()
            off += flen
        records.append(None if rec[:1] == b"*" else row)

    features, off = [], 100
    for row in records:
        _, length = struct.unpack(">ii", shp[off:off + 8])
        shape_type = struct.unpack("<i", shp[off + 8:off + 12])[0]
        if row and shape_type == 1:
            x, y = struct.unpack("<dd", shp[off + 12:off + 28])
            props = {"DEU_TEXT": row.get("DEU_TEXT"), "WIS_TEXT": row.get("WIS_TEXT"), "TYP": row.get("TYP"), "STRASSE": row.get("STRASSE"),
                     "KRONE_DM": float(row["KRONE_DM"]) if row.get("KRONE_DM") else None,
                     "ST_UMFANG": float(row["ST_UMFANG"]) if row.get("ST_UMFANG") else None}
            features.append(point(x, y, {k: v for k, v in props.items() if v not in (None, "")}, digits=5))  # ~1 m
        off += 8 + length * 2
    stand = re.search(r"HN(\d{4})", src.name).group(1)
    print(f"trees: {len(features)} from {src.name}")
    write(f"trees_hn_{stand}.geojson", {"type": "FeatureCollection", "features": features})


# ----------------------------------------------------------------------------- water hardness + quality per street

def street_key(name):
    s = name.lower().replace("ß", "ss").replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
    s = re.sub(r"str\.?$", "strasse", s)
    return re.sub(r"[^a-z0-9]", "", s)


def hardness_class(dh):
    return "soft" if dh < 8.4 else "medium" if dh <= 14 else "hard"  # German detergent law ranges


def water():
    folder = "wasserversorgung-und-wasserqualität-der-stadt-heilbronn"
    # analysis per hardness zone, latest year
    analysis_file = latest(folder, "HN_dH_*_GESAMT.csv")
    zones = {}
    for row in csv.DictReader(io.StringIO(read_text(analysis_file)), delimiter=";"):
        zone = (row.get("HN dh") or "").replace(" ", "")
        if not zone:
            continue
        en = lambda col: re.sub(r"(\d),(\d)", r"\1.\2", row[col]).strip()  # decimal commas -> points
        zones[zone] = {"year": row["JAHR"], "hardness_range": en("HAERTEBEREICH"), "nitrate": en("NITRAT"), "ph": en("PH - WERT"),
                       "conductivity": en("LEITFAEHIGKEIT BEI 25°C"), "calcium": en("CALCIUM"), "magnesium": en("MAGNESIUM"),
                       "chloride": en("CHLORID"), "sulphate": en("SULFAT"), "sodium": en("NATRIUM")}

    def zone_for(dh):  # '10' belongs to the analysis zone '10-11'
        return dh if dh in zones else next((z for z in zones if z.split("-")[0] == dh), None)

    streets = {}
    for row in csv.reader(io.StringIO(read_text(latest(folder, "*WASSERHAERTEN*"))), delimiter=";"):
        if len(row) < 2 or not re.fullmatch(r"\d+(-\d+)?", row[1].strip()):
            continue
        streets[street_key(row[0])] = (row[0].strip(), row[1].strip())

    ways = overpass(HN_AREA + 'way(area.a)["highway"]["name"];out geom;')
    features, matched = [], set()
    for w in ways:
        hit = streets.get(street_key(w["tags"]["name"]))
        if not hit or "geometry" not in w:
            continue
        matched.add(hit[0])
        dh = hit[1]
        parts = [float(p) for p in dh.split("-")]
        value = sum(parts) / len(parts)
        props = {"name": w["tags"]["name"], "dH": dh, "dH_value": value, "class": hardness_class(value)}
        z = zone_for(dh)
        if z:
            props.update({k: v for k, v in zones[z].items() if v})
        features.append({"type": "Feature", "properties": props,
                         "geometry": {"type": "LineString", "coordinates": [[round(p["lon"], 5), round(p["lat"], 5)] for p in w["geometry"]]}})
    print(f"water: {len(matched)} of {len(streets)} streets matched to OSM ({len(features)} ways), zones {sorted(zones)}")
    write("water_hardness.geojson", {"type": "FeatureCollection", "features": features})


# ----------------------------------------------------------------------------- traffic counting station

def traffic():
    folder = "kfz-zählstelle-karlsruher-straße-theresienstraße"
    per_year = defaultdict(lambda: defaultdict(float))
    detectors = set()
    for f in sorted((MIRROR / folder).glob("*.csv")):
        for row in csv.reader(io.StringIO(read_text(f)), delimiter=";"):
            if len(row) < 3 or not re.match(r"\d\d\.\d\d\.\d{4}", row[0]):
                continue
            day = datetime.strptime(row[0][:10], "%d.%m.%Y").date()
            per_year[day.year][day] += num(row[2]) or 0  # summed over all detectors of the junction
            detectors.add(row[1])
    aadt = {y: round(sum(days.values()) / len(days)) for y, days in sorted(per_year.items())}
    nodes = overpass(HN_AREA + 'way(area.a)["name"="Karlsruher Straße"]->.k;way(area.a)["name"="Theresienstraße"]->.t;node(w.k)(w.t);out;')
    lon, lat = nodes[0]["lon"], nodes[0]["lat"]
    station = sorted(detectors)[0].split("_")[0]
    props = {"name": "Karlsruher Straße / Theresienstraße", "station": station, "detectors": len(detectors),
             "vehicles_per_day": aadt[max(aadt)], "latest_year": max(aadt)}
    props.update({f"vehicles_per_day_{y}": v for y, v in aadt.items()})
    print(f"traffic: station {station} ({len(detectors)} detectors), vehicles/day {aadt}")
    write("traffic_counter.geojson", {"type": "FeatureCollection", "features": [point(lon, lat, props)]})


# ----------------------------------------------------------------------------- landfills, biomass plants

def landfills():
    rows = list(csv.DictReader(io.StringIO(read_text(latest("abfalldeponien", "*.csv"))), delimiter=";"))
    features = []
    for r in rows:
        name = r["Arbeitsstätte"]
        clean = re.sub(r"\b(DK0|DKI+|DKII|Erddeponie)\b|;", " ", name)
        clean = re.sub(r"\s+", " ", clean).strip()
        tries = [name, clean, f"{clean}, {r['Standortgemeinde']}", re.sub(r"^Deponie ", "", clean) + f", {r['Standortgemeinde']}"]
        hit = next((h for q in dict.fromkeys(tries) if (h := nominatim(q))), None)
        if not hit:
            print(f"  ! landfill not found: {name}")
            continue
        features.append(point(hit[0], hit[1], {"name": name, "class": r["Deponieklasse"], "status": r["Anlagenstatus"],
                                               "authority": r["Zuständige Dienststelle"], "located_as": hit[2]}))
    print(f"landfills: {len(features)} of {len(rows)} located")
    write("landfills.geojson", {"type": "FeatureCollection", "features": features})


def biomass():
    text = read_text(latest("biomassefeuerungsanlagen", "*.csv"))
    lines = text.splitlines()
    start = next(i for i, l in enumerate(lines) if l.startswith('"Betreibername"'))
    rows = list(csv.DictReader(io.StringIO("\n".join(lines[start:]))))
    sites = {}
    for r in rows:
        key = (r["Betreibername"], r["Strasse"], r["Hausnummer"], r["Postleitzahl"])
        s = sites.setdefault(key, {"operator": r["Betreibername"], "address": f"{r['Strasse']} {r['Hausnummer']}, {r['Postleitzahl']} {r['Ort']}",
                                   "sector": r["Wirtschaftszweig"], "units": 0, "kw": 0, "mwh_per_year": 0, "wood_t_per_year": 0,
                                   "co2_avoided_t_per_year": 0, "source": f"{r['Herkunft der Daten']} {r['Stand der Daten']}"})
        s["units"] += 1
        for col, k in (("Installierte Leistung [kW]", "kw"), ("Erbrachte Wärmeenergie [MWh/a]", "mwh_per_year"),
                       ("Holzmenge [t/a]", "wood_t_per_year"), ("Vermiedene CO2-Emission [t/a]", "co2_avoided_t_per_year")):
            s[k] = round(s[k] + (num(r[col]) or 0), 1)
    features = []
    for s in sites.values():
        hit = nominatim(s["address"])
        if not hit:
            print(f"  ! address not found: {s['address']}")
            continue
        features.append(point(hit[0], hit[1], s))
    print(f"biomass: {len(features)} of {len(sites)} sites located ({len(rows)} plants)")
    write("biomass_plants.geojson", {"type": "FeatureCollection", "features": features})


# ----------------------------------------------------------------------------- city-wide tables

def climate_table():
    rows = list(csv.DictReader(io.StringIO(read_text(latest("jährliche-klimadaten", "*.csv"))), delimiter=";"))
    cols = [("temperatur_heisse_tage", "Hot days"), ("temperatur_tropennaechte", "Tropical nights"),
            ("temperatur_frosttage", "Frost days"), ("temperatur_mittelwert", "Mean °C")]
    years = {int(r["Jahr"]): r for r in rows}
    out = []
    for start in range(1961, max(years) - 4, 10):
        span = [years[y] for y in range(start, start + 10) if y in years]
        if len(span) == 10:
            out.append([f"{start}–{start + 9}"] + [round(sum(num(r[c]) for r in span) / 10, 1) for c, _ in cols])
    for y in sorted(years)[-5:]:
        out.append([str(y)] + [round(num(years[y][c]), 1) for c, _ in cols])
    write("climate_table.json", {"title": f"Climate in Heilbronn {min(years)}–{max(years)}", "columns": ["Period"] + [l for _, l in cols],
                                 "rows": out, "note": "Decade means, then single years. Hot day: max. ≥ 30 °C; tropical night: min. ≥ 20 °C; frost day: min. < 0 °C."})


def water_supply_table():
    lines = read_text(latest("wasserversorgung-heilbronn", "*.csv")).splitlines()
    head = next(l for l in lines if l.startswith(";;2004")).split(";")
    labels = {"Insgesamt1)": "Abstraction (1,000 m³)", "Grundwasser2)": "of which groundwater", "Insgesamt": "Delivered to users (1,000 m³)",
              "Haushalte3)": "of which households", "täglich pro Kopf": "Per person per day (l)", "Leitungsverluste4)": "Pipe losses (1,000 m³)",
              "An die öffentliche Wasserversorgung angeschlossene Einwohner5)": "Population connected (%)"}
    years = head[2:7]
    rows = []
    for l in lines:
        c = l.split(";")
        if c[0] in labels and len(c) >= 8:
            rows.append([labels[c[0]]] + [num(c[i]) for i in (2, 4, 6)] + [num(c[7]) if "Kopf" in c[0] or "%" in c[1] else "–"])
    write("water_supply_table.json", {"title": "Public water supply, Heilbronn", "columns": ["", years[0], years[2], years[4], "BW " + head[7]],
                                      "rows": rows, "note": "BW = Baden-Württemberg, comparable for per-person and percentage values only."})


def city_boundary():
    gj = json.loads(http("https://opendata.heilbronn.de/sites/default/files/Heilbronn_Stadtkreisgrenzen_Gen_0.geojson"))
    write("city_boundary.geojson", gj)


def main():
    DATA.mkdir(exist_ok=True)
    for step in (trees, water, traffic, landfills, biomass, climate_table, water_supply_table, city_boundary):
        step()


if __name__ == "__main__":
    main()
