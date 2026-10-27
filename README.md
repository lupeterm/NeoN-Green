# NeoN-Green: "What if we planted trees here?"

An interactive street map of Heilbronn with a heat overlay. Draw around part of a street
and plant trees on it, evenly spaced or by hand. The overlay recalculates live, and the
panel shows how much cooler the street gets on average. Tree shadows follow the sun for
the chosen date and time of day. Existing trees and the bike measurements of the
Heilbronn senseBox:bike campaign can be shown as extra layers.

Built for education and for cheaply comparing urban-planning options. It is not a
microclimate simulation.

## Run

```bash
python3 -m http.server 8765
```

Open <http://localhost:8765>. No build step and no API keys. MapLibre GL JS, Turf and
SunCalc load from unpkg, and the basemap is CARTO Positron.

## Using it

1. Pick the heat dataset, date and time of day in the left panel. The sun position updates with them.
2. Zoom in to street level and press **Draw a section**, then drag around the part of the street
   you mean. The street with the longest stretch inside the shape is chosen, and the section snaps
   to exactly that stretch. Clicking a street instead selects all of it.
3. In the right panel, choose **evenly spaced** and set the number of trees, or **by hand** and
   click the map to plant trees and click a new tree to remove it. Switching to by hand starts
   from the current even layout.
4. Read the result: the mean value within 10 m on both sides of the section, before and after,
   plus the strongest local cooling, the shaded area and an assumed cost.

Trees are only planted where there is room: not on a roadway (width estimated from the road
class), not inside a building or water, and not under the crown of an existing or another
new tree. Evenly spaced trees go to the kerb on alternating sides and slide along the street
until they fit. The panel says how many of the requested trees fit; a click by hand that
does not fit says why.

## Files

```
index.html          page and styles
app.js              map, data loading, street selection, UI
worker.js           background computation: interpolation, scenario, PNG rendering
model.js            tree cooling model (shared by app and worker)
config/overlays.json  heat datasets ("overlays") and extra map layers ("layers")
config/model.json     model and tree placement parameters
data/heat_sensors.csv sensor.community temperatures, Heilbronn, 2 July 2025, 10-minute means
data/trees_hn_innenstadt_2017.geojson  tree inventory of the city centre, 2017
```

## Plugging in data

### Heat overlays

An overlay is any set of point measurements with a numeric value. It is interpolated
into the heat map that the tree model works on. Add an entry to `overlays` in
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

### Extra layers

Entries in `layers` are drawn as they are, without interpolation. Each is a GeoJSON URL:

```json
{
  "id": "bike_speed",
  "group": "Bike measurements (atrai)",
  "label": "Cycling speed",
  "url": "https://api.atrai.bike/collections/speed_map_heilbronn/items?limit=0",
  "type": "line",
  "value": "avg_speed[km/h]", "unit": "km/h", "domain": [5, 30],
  "ramp": ["#b10026", "#fd8d3c", "#fecc5c", "#31a354"],
  "tooltip": {"name": "Street", "avg_speed[km/h]": "Mean speed (km/h)"}
}
```

* `type` is `line` or `circle`. With `value`, features are coloured along `ramp` over `domain`
  and a legend appears; without it they use `color`.
* Layers without `group` get a checkbox, layers sharing a `group` share one dropdown.
* `crownDiameterField` draws circles to scale in metres. `"obstacle": true` additionally makes
  these points block tree placement, as the existing trees do.
* `tooltip` maps property names to the labels shown on hover.

### Interpolation

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

Known simplifications: buildings neither cast shadows nor block tree shadows, road widths are
estimated from the road class, and wind and surfaces are ignored. The default values are
plausible orders of magnitude for Central European summer days, not calibrated results. Tune
them in `config/model.json`, or replace `model.js` with a better model behind the same
`treeEffect()` function.

## Bike data

The bike layers come straight from the public atrai API at <https://api.atrai.bike>
(documented at <https://hackathon.greencity.hn/resources/bike-data>): overtaking distance,
overtaking danger spots, road roughness, cycling speed and traffic flow for Heilbronn. The
fine-dust risk points (`danger_zones_PM_heilbronn`, 37 MB) are left out because of their size.

### Local ingestor (optional)

The second heat overlay reads senseBox:bike measurements of the Heilbronn campaign from the
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
choosing that overlay shows "is not available" and the map keeps the current data.

## Data and licences

| Data | Source | Licence |
|---|---|---|
| `data/heat_sensors.csv` | [sensor.community](https://sensor.community) archive | ODbL |
| `data/trees_hn_innenstadt_2017.geojson` | Stadt Heilbronn tree inventory, city centre, 2017 | not stated in the file |
| Bike layers | [atrai API](https://api.atrai.bike), senseBox:bike campaign Heilbronn | not stated on the page |
| senseBox:bike (live) | [openSenseMap](https://opensensemap.org), grouptag `heilbronn` | PDDL |
| Basemap | © OpenStreetMap contributors, © CARTO | ODbL / CARTO terms |

Citizen temperature sensors are often unshaded and read several degrees above the
meteorological air temperature on sunny days.
