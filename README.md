# NeoN-Green: "What if we planted trees here?"

An interactive street map of Heilbronn with a heat overlay. Zoom in, click a street,
narrow it down to a section and plant trees on it. The overlay recalculates live, and
the panel shows how much cooler the street gets on average. Tree shadows follow the
sun for the chosen date and time of day.

Built for education and for cheaply comparing urban-planning options. It is not a
microclimate simulation.

## Run

```bash
python3 -m http.server 8765
```

Open <http://localhost:8765>. No build step and no API keys. MapLibre GL JS, Turf and
SunCalc load from unpkg, and the basemap is CARTO Positron.

## Using it

1. Pick the dataset, date and time of day in the left panel. The sun position updates with them.
2. Zoom in to street level and click a street. All loaded pieces with the same name are joined.
   Or click one of the heat hotspots listed under the colour scale: the map flies there, selects
   the street and preselects 200 m around the hotspot.
3. In the right panel, choose the section, the number of trees and the tree size.
4. Read the result: the mean value within 10 m on both sides of the section, before and after,
   plus the strongest local cooling, the shaded area and an assumed cost.

## Files

```
index.html          page and styles
app.js              map, data loading, street selection, UI
worker.js           background computation: interpolation, scenario, PNG rendering
model.js            tree cooling model (shared by app and worker)
config/overlays.json  datasets shown in the "Daten" dropdown
config/model.json     all model parameters
data/heat_sensors.csv sensor.community temperatures, Heilbronn, 2 July 2025, 10-minute means
data/atrai_bike.csv   senseBox:bike measurements, Heilbronn, 1–7 Sep 2026 (snapshot)
data/hotspots.geojson five warm street spots found in the bike rides (list in the left panel)
scripts/fetch_atrai.py    regenerates data/atrai_bike.csv for any period
scripts/find_hotspots.py  regenerates data/hotspots.geojson
```

## Plugging in data

An overlay is any set of point measurements with a numeric value. Add an entry to
`config/overlays.json` and reload:

```json
{
  "id": "my-data",
  "label": "Shown in the dropdown",
  "url": "data/my-data.csv",
  "format": "csv",
  "lon": "lon", "lat": "lat", "value": "temperature",
  "time": "timestamp",
  "unit": "°C",
  "domain": [20, 40],
  "refreshSeconds": 300
}
```

* `format` is `csv` (comma or semicolon), `json` (array of objects, or `path` to the array)
  or `geojson`. GeoJSON takes the point coordinates, or the centroid of other geometries,
  so `lon` and `lat` are not needed there.
* `time` is optional. If given, the map shows, per location, the value closest to the
  selected time of day. Timestamps without a zone are read as local time.
* `domain` fixes the colour scale. Without it, the 2nd to 98th percentile is used.
* `refreshSeconds` re-fetches the URL periodically, for live sources.
* `url` can point to any HTTP endpoint that allows cross-origin requests.

Points are interpolated by inverse distance weighting. Sparse networks (up to 300 points)
use all points everywhere. Dense data such as bike tracks only uses points within
`grid.idw_radius_m` and leaves gaps elsewhere.

## The model

`model.js`, with parameters in `config/model.json`:

* **Shade.** Each crown is a sphere whose shadow is projected along the sun ray: an ellipse,
  offset away from the sun and stretched at low sun. Inside it the felt temperature drops by
  up to `shade.max_cooling_K`, scaled by sun altitude. No effect when the sun is below the horizon.
* **Evapotranspiration.** Each tree cools the air around it by a Gaussian bump. Several trees
  add up but saturate at `evapotranspiration.max_total_K`, and the effect is weaker at night.

Known simplifications: buildings neither cast shadows nor block tree shadows, trees sit on the
street axis, and wind, surfaces and street geometry are ignored. The default values are
plausible orders of magnitude for Central European summer days, not calibrated results. Tune
them in `config/model.json`, or replace `model.js` with a better model behind the same
`treeEffect()` function.

## Live bike data (optional)

The second overlay reads senseBox:bike measurements of the Heilbronn campaign from the
[atrai-bikes-ingestor](https://github.com/reedu-reengineering-education/atrai-bikes-ingestor),
included as the submodule `ingestor/`. It syncs the openSenseMap archive into PostGIS every
6 hours and serves the points at `http://localhost:8000/collections/track_points/items`.

```bash
git submodule update --init
```

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

The map is then also served at <http://localhost:8080>. While the ingestor is not running,
choosing that overlay shows "nicht verfügbar" and the map keeps the current data.

Without Docker, the overlay "senseBox:bike 1.–7.9.2026" shows a snapshot of the same
campaign from `data/atrai_bike.csv`. `scripts/fetch_atrai.py` pulls it straight from the
openSenseMap archive (Python stdlib only, about 15 s per week of data):

```bash
python3 scripts/fetch_atrai.py --from 2026-09-01 --to 2026-09-07
```

One row per timestamp and bike: `zeit` (local time), `box`, `lat`, `lon`, `pm25`, `pm10`,
`pm1` (µg/m³), `temperatur` (°C), `luftfeuchte` (%), `tempo_kmh`. Points outside the
city's bounding box and out-of-range values are dropped. Coverage is uneven: a few
regular riders contribute most points, so dense streets are not necessarily hotter or
more polluted ones.

### Hotspots

`data/hotspots.geojson` lists streets where the bikes measured it warmer than elsewhere on
the same ride. Comparing rides directly would mostly compare times of day, so every reading
is taken relative to the median of its own ride. These anomalies are averaged in 100 m grid
cells, first per ride and then over rides. A cell needs at least 8 rides by 2 different bikes,
and cells are ranked by mean minus standard error. Readings below 5 km/h (sensor heats up
while standing) and the first 3 minutes of a ride (box still adapting) are ignored. Bikes
often use paths and tracks, so a cell only counts if Nominatim finds a street within 25 m;
the hotspot is moved onto it. Regenerate from a longer period than the overlay snapshot,
which is too short for stable results:

```bash
python3 scripts/fetch_atrai.py --from 2026-06-01 --to 2026-10-26 --out /tmp/atrai_jun_oct.csv
python3 scripts/find_hotspots.py /tmp/atrai_jun_oct.csv
```

The effects are small (+0.2 to +0.7 K, standard error 0.1 to 0.3 K) and come from mobile
low-cost sensors: treat the list as candidates to look at, not as measured heat islands.

## Data and licences

| Data | Source | Licence |
|---|---|---|
| `data/heat_sensors.csv` | [sensor.community](https://sensor.community) archive | ODbL |
| senseBox:bike (live) | [openSenseMap](https://opensensemap.org), grouptag `heilbronn` | PDDL |
| `data/atrai_bike.csv` | [openSenseMap](https://opensensemap.org) archive, grouptag `heilbronn` | PDDL |
| `data/hotspots.geojson` | derived from the above, 11 Jun – 22 Oct 2026; street names © OpenStreetMap contributors via [Nominatim](https://nominatim.org) | ODbL |
| Basemap | © OpenStreetMap contributors, © CARTO | ODbL / CARTO terms |

Citizen temperature sensors are often unshaded and read several degrees above the
meteorological air temperature on sunny days.
