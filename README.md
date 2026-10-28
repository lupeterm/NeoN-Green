# NeoN-Green: "What if we planted trees here?"

An interactive street map of Heilbronn with a heat overlay. Draw around part of a street
and plant trees on it, evenly spaced or by hand. The overlay recalculates live, and the
panel shows how much cooler the street gets on average. Tree shadows follow the sun for
the chosen date and time of day. Existing trees and environment data from the city's open
data portal can be shown as extra layers.

Built for education and for cheaply comparing urban-planning options. It is not a
microclimate simulation.

## Run

```bash
python3 -m http.server 8765
```

Open <http://localhost:8765>. No build step and no API keys. After editing a file, reload with
Ctrl+Shift+R (Cmd+Shift+R on macOS): the simple Python server lets browsers keep old copies. MapLibre GL JS, Turf and
SunCalc load from unpkg, and the basemap is CARTO Positron.

## Using it

1. Pick the data, date and time of day in the left panel: heat (citizen sensors or senseBox:bike),
   particulate matter (PM10, PM2.5 from the same sensors) or road traffic noise. The sun position
   updates with date and time.
2. Zoom in to street level and press **Draw a section**, then drag around the part of the street
   you mean. The street with the longest stretch inside the shape is chosen, and the section snaps
   to exactly that stretch. Clicking a street instead selects all of it. Or click one of the heat
   hotspots listed under the colour scale: the map flies there, selects the street and preselects
   200 m around the hotspot.
3. In the right panel, choose **evenly spaced** and set the number of trees, or **by hand** and
   click the map to plant trees and click a new tree to remove it. Switching to by hand starts
   from the current even layout.
4. Read the result: the mean value within 10 m on both sides of the section, before and after,
   plus the strongest local cooling and the shaded area.

**3D street view (prototype).** With a street selected, "3D street view" in the right panel
puts the camera at eye height (1.8 m) at the start of the section, looking along it. Buildings are extruded from the
basemap (real height where known, otherwise 10 m), and planted and nearby existing trees appear
as 3D models scaled to their real crown and height: leafy trees, crooked pines (with a pumpkin
at each new tree for Halloween) or decorated and snowy firs, following the tree style. Heights of
existing trees are estimated from their crown, as the inventory has none. The models are drawn
with deck.gl, which loads only when 3D is first opened; if it cannot load, simple trunk-and-crown
blocks are shown instead. Models are set per style in `iconThemes.<style>.models3d` in
`config/overlays.json` (`size` = the model's extent in model units, y up). Drag with the right
mouse button to look around; zooming moves the camera up or down. "Back to top-down map" returns
to the plan view. Buildings without a height in the basemap (most of them) are drawn 10 m high,
so trees behind taller real buildings can still show over the roofs.

The sun/moon button under the zoom controls switches between a light and a dark map, and the
three buttons below it switch the tree icons between normal, Halloween and Christmas. It starts
with the system setting and remembers the choice in the browser. Switching keeps the selected
street, the trees and all layers.

Trees are only planted where there is room: not on a roadway (width estimated from the road
class), not inside a building or water, and never overlapping the crown of an existing tree
(`placement.existing_tree_spacing`; new trees may overlap each other slightly, `crown_overlap`). Evenly spaced trees alternate sides, but an existing tree claims its side of the street for
the stretch around it (half a spacing either way): the new tree goes to the other side, or the
spot is skipped and counted as "already treed" when both sides have trees
(`placement.existing_trees_claim_side`). A blocked spot first moves away from the
centre line, up to `placement.max_offset_m` but never past a building or water, and then
slides along the street until it fits. The panel says how many of the requested trees fit; a click by hand that
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
data/trees_hn_2026.geojson  city tree inventory, 1 Jan 2026 (43,031 trees)
data/water_hardness.geojson, traffic_counter.geojson, landfills.geojson, biomass_plants.geojson,
data/climate_table.json, water_supply_table.json, city_boundary.geojson
                      environment layers from opendata.heilbronn.de (see "Environment data")
data/atrai_bike.csv   senseBox:bike measurements, Heilbronn, 1–7 Sep 2026 (snapshot)
data/hotspots.geojson five warm street spots found in the bike rides (list in the left panel)
scripts/fetch_atrai.py    regenerates data/atrai_bike.csv for any period
scripts/find_hotspots.py  regenerates data/hotspots.geojson
scripts/fetch_opendata.py    mirrors the portal's environment datasets into opendata/ (git-ignored)
scripts/prepare_opendata.py  builds the environment layers and the tree file from that mirror
scripts/prepare_noise.py     builds data/noise_road_lden.csv from the EU noise mapping 2022
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
  "id": "water_hardness",
  "group": "Environment data (opendata.heilbronn.de)",
  "label": "Water hardness & quality by street",
  "url": "data/water_hardness.geojson",
  "type": "line",
  "value": "dH_value", "unit": "°dH", "domain": [8, 18],
  "ramp": ["#4dabf7", "#a5d8ff", "#ffe066", "#ff922b", "#e8590c"],
  "tooltip": {"name": "Street", "dH": "Hardness (°dH)"}
}
```

* `type` is `line`, `circle` or `table`. With `value`, features are coloured along `ramp` over
  `domain` and a legend appears; without it they use `color`. A `table` layer points to a JSON
  file with `title`, `columns`, `rows` and `note`: the table appears in the panel and the city
  outline (`cityBoundary`) on the map, for city-wide figures without locations.
* `radius` ([at zoom 12, at zoom 18], px) sizes circles, `minzoom` hides a layer below a zoom
  level, and `"fitOnShow": true` zooms to the data when the layer is chosen.
* Layers without `group` get a checkbox, layers sharing a `group` share one dropdown.
* `crownDiameterField` draws circles to scale in metres, or the image in `icon` (see below). `"obstacle": true` additionally makes
  these points block tree placement, as the existing trees do.
* `tooltip` maps property names to the labels shown on hover.

### Tree icons

Trees are drawn as icons from `assets/`, in three styles you can switch with the 🌳 🎃 🎄 buttons
under the dark mode button: normal, Halloween and Christmas. By default the style follows the date
(Halloween in October, Christmas in December, normal otherwise); a choice is remembered in the
browser. The styles are defined in `iconThemes` in `config/overlays.json`:

```json
"christmas": {"label": "Christmas", "symbol": "🎄",
              "planted": "assets/christmas-tree-planted.svg", "trees": "assets/christmas-tree-existing.svg"}
```

`planted` is the icon for new trees, any other key is the id of a layer with `crownDiameterField`.
An icon is a 128 × 128 px image whose central disc of 120 px is scaled to the crown diameter on
the map. Without `iconThemes` the map draws plain circles.

### Interpolation

Points are interpolated by inverse distance weighting. Sparse networks (up to 300 points)
use all points everywhere. Dense data such as bike tracks only uses points within
`grid.idw_radius_m` and leaves gaps elsewhere.

## The model

`model.js`, with parameters in `config/model.json`:

* **Shade.** Each crown is a sphere whose shadow is projected along the sun ray: an ellipse,
  offset away from the sun and stretched at low sun. Inside it the felt temperature drops by
  up to `shade.max_cooling_C`, scaled by sun altitude. No effect when the sun is below the horizon.
* **Evapotranspiration.** Each tree cools the air around it by a Gaussian bump. Several trees
  add up but saturate at `evapotranspiration.max_total_C`, and the effect is weaker at night.
* **Particulate matter (PM10, PM2.5).** New trees change the concentration in the street
  corridor by a percentage that depends on the street type and scales with the share of the
  corridor under their crowns: up to `pollution.canyon_increase_pct` more in a street canyon
  (tree crowns slow the air exchange), up to `pollution.deposition_pct_full_cover` less on an
  open street (deposition on leaves). A point of the section counts as street canyon when
  buildings stand within `pollution.canyon_max_halfwidth_m` of the street axis on both sides;
  the two effects are blended by the canyon share of the section. The linear scaling with crown
  cover is a simplification.
* **Noise.** Rows of street trees change road traffic noise by `noise.tree_row_dB` (0 dB):
  measurable reductions need dense tree belts of 15–20 m depth, which streets do not have.

Which part applies follows the selected data: overlays have a `quantity` of `temperature`,
`pm` or `noise` in `config/overlays.json`.

Known simplifications: buildings neither cast shadows nor block tree shadows, road widths are
estimated from the road class, and wind and surfaces are ignored. The model adds the shade
effect on felt temperature to measured air temperature, so its results are not air
temperatures. The default values are rough estimates, not fitted to measurements. Tune
them in `config/model.json`, or replace `model.js` with a better model behind the same
`treeEffect()` function.

"Model sources" in the scenario panel lists, for each part of the model, the values it uses
next to what studies measured, with links to the studies. The list is `sources` in
`config/model.json`; `{shade.max_cooling_C}` and similar placeholders show current parameter
values. Current references:

* Rahman & Ennos (2016), [What we know and don't know about the cooling benefits of urban trees](https://www.tdag.org.uk/uploads/4/2/8/0/4280686/what_is_known_and_not_know_cooling_benefits_of_urban_trees.pdf):
  tree shade lowers PET by 7–15 °C on hot days; green areas can cool more at night than by day.
* Rahman et al. (2018), [Vertical air temperature gradients under the shade of two contrasting urban tree species](https://treefund.org/wp-content/uploads/2018/04/Rahman-et-al.-2018.pdf),
  Science of the Total Environment 633: air under canopies 0.5–1.8 °C cooler (Munich), 0.1–2.8 °C in other studies.
* [SunCalc](https://github.com/mourner/suncalc) for the sun position.

## Environment data

The group "Environment data (opendata.heilbronn.de)" holds the portal's datasets on pollution,
climate and related topics that come with files:

| Option | Data | How it is placed |
|---|---|---|
| Water hardness & quality by street | hardness per street (2020) and the water analysis of each hardness zone | streets matched by name to OpenStreetMap |
| Traffic counting station | vehicles per day 2018–2023, Karlsruher Straße / Theresienstraße (sum of 6 detectors) | junction from OpenStreetMap |
| Landfills | the 3 landfills in the city, class and status | located by name, approximate |
| Biomass heating plants (region) | 6 sites in Heilbronn-Franken with output, wood use and avoided CO₂ (LUBW 2016) | located by address |
| Climate 1961–2025 | hot days, tropical nights, frost days and mean temperature per decade and year | city-wide table |
| Water supply 2004–2016 | abstraction, delivery, use per person, pipe losses | city-wide table |

Not available as files on the portal: air quality (Immissionsdaten, links to the LUBW station
page), the climate profile and weather warnings (links to LUBW and DWD), and CO₂ emissions and
traffic load (linked tables of the Statistisches Landesamt, which moved to GENESIS-Online).

To refresh, mirror the portal and rebuild the files; coordinates from OpenStreetMap are cached
in `opendata/_lookups.json`:

```bash
python3 scripts/fetch_opendata.py
```

```bash
python3 scripts/prepare_opendata.py
```

## senseBox:bike data

### Snapshot overlay

The heat overlay "Heat – senseBox:bike, 1–7 Sep 2026" shows a snapshot of the Heilbronn
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

The effects are small (+0.2 to +0.7 °C, standard error 0.1 to 0.3 °C) and come from mobile
low-cost sensors: treat the list as candidates to look at, not as measured heat islands.

## Data and licences

| Data | Source | Licence |
|---|---|---|
| `data/heat_sensors.csv` | [sensor.community](https://sensor.community) archive | ODbL |
| `data/noise_road_lden.csv` | Umweltbundesamt, Lärmkartierung Deutschland 2022 (data of Stadt Heilbronn), road traffic Lden in the agglomeration, sampled on a 25 m grid | © UBA, attribution |
| `data/trees_hn_2026.geojson` | [Stadt Heilbronn, Baumkataster](https://opendata.heilbronn.de/dataset/baumkataster), 1 Jan 2026 | DL-DE BY 2.0 |
| Environment layers | [opendata.heilbronn.de](https://opendata.heilbronn.de) (biomass plants: LUBW); street geometry and locations © OpenStreetMap contributors | CC BY 4.0 / DL-DE BY 2.0; geometry ODbL |
| `data/atrai_bike.csv` | [openSenseMap](https://opensensemap.org) archive, grouptag `heilbronn` | PDDL |
| `data/hotspots.geojson` | derived from the above, 11 Jun – 22 Oct 2026; street names © OpenStreetMap contributors via [Nominatim](https://nominatim.org) | ODbL |
| 3D tree models (`assets/models/`) | [Kenney](https://kenney.nl): Nature Kit, Graveyard Kit, Holiday Kit | CC0 |
| Basemap | © OpenStreetMap contributors, © CARTO | ODbL / CARTO terms |

Citizen temperature sensors are often unshaded and read several degrees above the
meteorological air temperature on sunny days.
