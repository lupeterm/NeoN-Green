# NeoN-Green

Interactive map of Heilbronn's environmental data, built on [kepler.gl](https://kepler.gl).
The goal: pick a small area (a street, a square), apply a "what if" (plant five trees,
cut speed to 30 km/h, …) and see the effect on heat, noise or air quality. Educational,
and a cheap way to compare urban-planning options.

This repo is the data foundation for that: one page, a handful of swappable datasets,
no build step.

## Run

```bash
python3 -m http.server 8765
```

Open <http://localhost:8765>. The page needs a web server (it fetches the data files);
libraries come from unpkg, the basemap is CARTO via MapLibre, no API keys.

## How it fits together

```
index.html             loads the manifest, feeds every file into kepler.gl, applies the config
data/manifest.json     which files to show, as which kepler.gl dataset
data/*.csv|geojson     one file per dataset
config/kepler.json     layers, filters, tooltips, viewport (kepler.gl "saved config" format)
```

### Swapping data

Data changes; the page does not. To replace a dataset, overwrite its file with one that
has the same columns and reload. To add one, drop the file in `data/`, list it in
`manifest.json` and add a layer for it in `config/kepler.json` (or configure it in the UI
and copy the result from *Share → Export Map → JSON*).

Time filters in the config carry an `auto` block instead of fixed timestamps, so a file
covering a different day or year still gets a sensible default window:

```json
"auto": {"anchor": "start", "offsetMinutes": 780, "windowMinutes": 30}
```

Timestamps in the CSVs are local time without a zone; kepler.gl reads them as UTC, which
makes the timeline and tooltips show local time.

## Datasets

| id | what | source | licence |
|---|---|---|---|
| `heat` | temperature, humidity and PM of citizen sensors on one hot day, 10-minute means per location | sensor.community archive | ODbL |
| `air` | daily means and 1-h maxima of NO₂, PM10, PM2.5, O₃ at the two LUBW stations DEBW015 (background) and DEBW152 (traffic) | Umweltbundesamt air-data API | DL-DE BY 2.0 |
| `noise` | EU noise mapping 2022, road traffic Lden bands (55–59 … ≥ 75 dB(A)) for the Heilbronn agglomeration; calculated, not measured | Umweltbundesamt datahub (data by Stadt Heilbronn) | © UBA, attribution |
| `districts` | district boundaries | Stadt Heilbronn open data | DL-DE BY 2.0 |

Caveats: citizen temperature sensors are often unshaded and read several degrees above
air temperature on hot days. The city's own climate analysis maps (Klimaanalysekarte,
felt temperature, cold-air flows) exist only as PDFs and are not included.

## Towards "what if"

kepler.gl already lets you draw a polygon on the map (pen icon, top right) that filters
every layer to that area. The missing piece is a scenario layer: take the points inside
the selection, apply a model (trees → shading → Δ temperature), and add the result as
another dataset through the same manifest.
