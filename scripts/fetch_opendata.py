#!/usr/bin/env python3
"""Mirror the environment datasets of opendata.heilbronn.de: licence and all files.

Only the datasets in KEEP are mirrored (pollution, temperature/climate and related sources);
pass --all to mirror the whole portal.

    python3 scripts/fetch_opendata.py    # writes opendata/<dataset>/<file>, index.csv, index.json

The portal (Drupal/DKAN) has no working CKAN API, but /catalog.xml lists all datasets and
distributions as DCAT-RDF, and /dcatapde/dataset/<slug>.json carries the licence. Distributions
without a downloadURL are resource pages; the file link is scraped from the page. Tables of the
Statistisches Landesamt BW linked from resource pages are fetched as CSV. Links to other portals
(MobiData BW, LUBW, DWD, Zensus, ...) are listed in the index but not mirrored. Re-running skips files that
are already there.
"""
import concurrent.futures as cf
import csv
import html
import json
import pathlib
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

BASE = "https://opendata.heilbronn.de"
OUT = pathlib.Path(__file__).resolve().parents[1] / "opendata"  # git-ignored mirror
R = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}"
UA = {"User-Agent": "NeoN-Green opendata mirror (python-urllib)"}

KEEP = {  # dataset slug on the portal -> why it is here
    "immissionsdaten-heilbronn": "air pollution measurements (LUBW station DEBW015)",
    "kohlendioxid-emissionen-heilbronn": "CO2 emissions",
    "jährliche-klimadaten": "annual climate indicators (hot days, tropical nights, ...)",
    "klimaprofil-heilbronn": "climate profile, past and projected",
    "wetterwarnungen": "weather and heat warnings",
    "kfz-und-verkehrsbelastung-heilbronn": "traffic load (emission source)",
    "kfz-zählstelle-karlsruher-straße-theresienstraße": "traffic counts (emission source)",
    "biomassefeuerungsanlagen": "biomass combustion plants (emission source)",
    "wasserversorgung-und-wasserqualität-der-stadt-heilbronn": "water quality",
    "wasserversorgung-heilbronn": "water supply",
    "öffentliche-wasserversorgung-heilbronn": "public water supply",
    "abfalldeponien": "landfills",
    "baumkataster": "tree inventory",
}


class _Follow308(urllib.request.HTTPRedirectHandler):
    """Python < 3.11 does not follow 308 Permanent Redirect (statistik-bw.de uses it)."""
    def http_error_308(self, req, fp, code, msg, headers):
        return self.http_error_302(req, fp, 302, msg, headers)


urllib.request.install_opener(urllib.request.build_opener(_Follow308()))
FILE_EXT = r"\.(csv|json|geojson|zip|xlsx?|pdf|png|jpe?g|kml|gpx|xml|txt|shp|gpkg)(\?|$)"


def get(url, timeout=120, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read(), r.headers.get("Content-Type", "")
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))


def text(el, name):
    for c in el:
        if c.tag.endswith("}" + name):
            return (c.text or c.get(R + "resource") or "").strip()
    return ""


def catalogue():
    root = ET.fromstring(get(f"{BASE}/catalog.xml")[0])
    dists = {el.get(R + "about"): {k: text(el, k) for k in ("title", "accessURL", "downloadURL", "format", "mediaType", "byteSize")}
             for el in root.iter() if el.tag.endswith("}Distribution") and el.get(R + "about")}
    out = []
    for el in root.iter():
        if not el.tag.endswith("}Dataset"):
            continue
        url = el.get(R + "about")
        out.append({"slug": urllib.parse.unquote(url.rstrip("/").split("/")[-1]), "url": url, "title": text(el, "title"),
                    "category": text(el, "keyword"), "tags": text(el, "theme"), "publisher": text(el, "publisher"),
                    "modified": text(el, "modified")[:10],
                    "distributions": [dists.get(c.get(R + "resource"), {"accessURL": c.get(R + "resource")})
                                      for c in el if c.tag.endswith("}distribution")]})
    return out


def licence(ds):
    try:
        g = json.loads(get(f"{BASE}/dcatapde/dataset/{urllib.parse.quote(ds['slug'])}.json", timeout=60)[0])
        found = set()
        def walk(o):
            if isinstance(o, dict):
                for k, v in o.items():
                    if k == "dct:license":
                        found.add(v.get("@id") if isinstance(v, dict) else str(v))
                    walk(v)
            elif isinstance(o, list):
                for x in o:
                    walk(x)
        walk(g)
        return ", ".join(sorted(x.rstrip("/").split("/licenses/")[-1] for x in found if x))
    except Exception as e:  # noqa: BLE001
        return f"? ({e.__class__.__name__})"


def file_links(page_url):
    """File links on a portal resource page (the 'download' button and plain links)."""
    body = get(page_url, timeout=60)[0].decode("utf-8", "replace")
    links = {html.unescape(h) for h in re.findall(r'href="([^"]+)"', body)}
    files = [urllib.parse.urljoin(BASE, h) for h in links
             if ("/sites/default/files/" in h and not h.endswith((".css", ".js")) and "/css/" not in h and "/js/" not in h)
             or (re.search(FILE_EXT, h, re.I) and h.startswith("http") and "opendata.heilbronn.de" not in h)]
    # tables of the Statistisches Landesamt BW: the same URL with form=csv returns the data as CSV
    for h in links:
        if re.match(r"https?://(www\.)?statistik-bw\.de/.+\.tab\?", h):
            files.append(h if "form=csv" in h else h + "&form=csv")
    return sorted(set(files))


def safe(name):
    return re.sub(r"[^\w.\-äöüÄÖÜß]+", "_", urllib.parse.unquote(name)).strip("_")[:120] or "file"


def download(url, folder):
    folder.mkdir(parents=True, exist_ok=True)
    name = urllib.parse.urlsplit(url).path.split("/")[-1]
    if "form=csv" in url:  # statistik-bw.de: 10023020.tab -> 10023020.csv
        name = re.sub(r"\.tab$", "", name) + ".csv"
    target = folder / safe(name)
    if target.exists() and target.stat().st_size > 0:
        return target, "kept"
    data, ctype = get(url, timeout=300)
    if "text/html" in ctype and not url.lower().endswith((".htm", ".html")):
        return None, "html page, not a file"
    target.write_bytes(data)
    return target, "downloaded"


def main():
    import sys
    OUT.mkdir(exist_ok=True)
    datasets = catalogue()
    print(f"{len(datasets)} datasets in catalog.xml")
    if "--all" not in sys.argv:
        datasets = [d for d in datasets if d["slug"] in KEEP]
        for d in datasets:
            d["why"] = KEEP[d["slug"]]
        print(f"keeping {len(datasets)} environment datasets (--all for everything)")
    with cf.ThreadPoolExecutor(4) as ex:
        for ds, lic in zip(datasets, ex.map(licence, datasets)):
            ds["licence"] = lic

    jobs = []  # (dataset, distribution, url)
    for ds in datasets:
        for d in ds["distributions"]:
            if d.get("downloadURL"):
                jobs.append((ds, d, d["downloadURL"]))
                continue
            page = d.get("accessURL", "")
            if page.startswith(f"{BASE}/dataset/"):
                try:
                    found = file_links(page)
                except Exception as e:  # noqa: BLE001
                    found, d["note"] = [], f"resource page failed: {e.__class__.__name__}"
                if found:
                    jobs.extend((ds, d, u) for u in found)
                    continue
            d.setdefault("note", "link only (web page or external service)")

    def run(job):
        ds, d, url = job
        try:
            path, status = download(url, OUT / safe(ds["slug"]))
        except Exception as e:  # noqa: BLE001
            path, status = None, f"failed: {e}"
        return ds, d, url, path, status

    rows = []
    with cf.ThreadPoolExecutor(4) as ex:
        for ds, d, url, path, status in ex.map(run, jobs):
            rows.append({"dataset": ds["title"], "why": ds.get("why", ""), "category": ds["category"], "modified": ds["modified"], "licence": ds["licence"],
                         "resource": d.get("title", ""), "format": d.get("format", ""), "url": url,
                         "file": str(path.relative_to(OUT)) if path else "", "bytes": path.stat().st_size if path else "",
                         "status": status, "dataset_page": ds["url"]})
            print(f"  {status:<12} {rows[-1]['file'] or url}")
    for ds in datasets:
        for d in ds["distributions"]:
            if d.get("note"):
                rows.append({"dataset": ds["title"], "why": ds.get("why", ""), "category": ds["category"], "modified": ds["modified"], "licence": ds["licence"],
                             "resource": d.get("title", ""), "format": d.get("format", ""), "url": d.get("accessURL", ""),
                             "file": "", "bytes": "", "status": d["note"], "dataset_page": ds["url"]})
    rows.sort(key=lambda r: (r["category"], r["dataset"], r["file"]))
    with open(OUT / "index.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    (OUT / "index.json").write_text(json.dumps(datasets, ensure_ascii=False, indent=1))
    ok = {r["file"]: r for r in rows if r["status"] in ("downloaded", "kept")}.values()
    print(f"\n{len(ok)} files, {sum(int(r['bytes']) for r in ok) / 1e6:.1f} MB; "
          f"{sum(r['status'].startswith('link only') for r in rows)} link-only resources; "
          f"{sum(r['status'].startswith(('failed', 'html', 'resource page')) for r in rows)} problems")


if __name__ == "__main__":
    main()
