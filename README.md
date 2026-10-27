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

## Data and licences

| Data | Source | Licence |
|---|---|---|
| `data/heat_sensors.csv` | [sensor.community](https://sensor.community) archive | ODbL |
| senseBox:bike (live) | [openSenseMap](https://opensensemap.org), grouptag `heilbronn` | PDDL |
| Basemap | © OpenStreetMap contributors, © CARTO | ODbL / CARTO terms |

Citizen temperature sensors are often unshaded and read several degrees above the
meteorological air temperature on sunny days.
