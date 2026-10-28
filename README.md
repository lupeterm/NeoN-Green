# NeoN-Green: "What if we planted trees here?"

An interactive street map of Heilbronn with a heat overlay. Draw around part of a street
and plant trees on it, evenly spaced or by hand, or try another measure instead: shade sails,
grass and flower beds, a reflective road surface, misting poles, or a speed limit and less traffic. The overlay recalculates live, and the
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
3. In the right panel, pick a **measure** (see "Measures" below). For trees, choose **evenly spaced** and set the number of trees, or **by hand** and
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

## Measures

The scenario panel tries one measure at a time; the list is sorted by how well each fits a
street in Heilbronn. Each changes the same heat map, and the panel adds what matters for it.

| Measure | Controls | Effect in the model | Also shown |
|---|---|---|---|
| Street trees | number or by hand, size | crown shade (felt) and evaporation (air) | shaded area |
| Shade sails | number, over the pavements or across the street | shade like a crown (× `shade_factor`), no air cooling | shaded area, sail area |
| Grass & flower beds | bed width, share of the section | a little air cooling around the beds, slightly lower felt temperature on them | bed area |
| Reflective road surface | albedo after coating | a little air cooling over the road, but reflected sun raises the felt temperature on road and pavements | both parts separately |
| Misting poles | number of poles | strong, very local air cooling, only during operating hours | water use |
| Speed limit & less traffic | 30 km/h, share of motor traffic | less engine heat over the road: almost nothing | engine heat in W/m², noise in dB(A) |

Beds are strips behind both kerbs (they move outward past tram tracks or other roads, never into a building).
Sails over the pavements alternate sides like trees (4 m high); across the street they span road
and pavements 6 m high. Misting poles are spaced like trees but ignore existing trees. Traffic volumes and current
speed limits are not known per street and are assumed from the road class. All parameters, with
notes, are under `measures` in `config/model.json`; "Model sources" shows the studies for the
selected measure. In the 3D street view trees and sails are drawn in the air; beds, coating
and mist reach show as flat areas on the ground.

## Files

```
index.html          page and styles
app.js              map, data loading, street selection, UI
worker.js           background computation: interpolation, scenario, PNG rendering
model.js            cooling model for trees and the other measures (shared by app and worker)
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
street.html, street.js    street view: place trees and cars on Weipertstraße
config/street.json        photo views, their camera calibration and the centre views
data/street/*.jpg         the photos, 1200 x 1600
data/street/centre/       AI views of the street from the centre of the road
scripts/centre_view.py    makes them on a GPU
data/street/sprites/      AI cut-outs of trees and cars for the street view
scripts/make_sprites.py   makes them on a GPU
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

Gridded data can set `"interpolation"` on its overlay instead: `{"mode": "nearest", "radius_m": 20}`
keeps each grid cell's value (crisp but boxy), `{"mode": "smooth", "sigma_m": 15, "cell_m": 25}`
takes a Gaussian-weighted mean of the grid points nearby. Where the grid ends, a place only gets a
value if at least half the weight of a full grid falls on existing points, so the edge is smoothed
too rather than extended. The noise map uses `smooth`: its 5 dB bands (sampled every 25 m) then
show as gradual transitions, which is a drawing aid, not a finer measurement.

## The model

`model.js`, with parameters in `config/model.json`:

* **Shade.** Each crown is a sphere whose shadow is projected along the sun ray: an ellipse,
  offset away from the sun and stretched at low sun. Inside it the felt temperature drops by
  up to `shade.max_cooling_C`, scaled by sun altitude. No effect when the sun is below the horizon.
* **Evapotranspiration.** Each tree cools the air around it by a Gaussian bump. Several trees
  add up but saturate at `evapotranspiration.max_total_C`, and the effect is weaker at night.
* **Other measures** (`measureEffect()` in `model.js`): a sail's shadow is its rectangle moved
  away from the sun by height / tan(sun altitude), cooling like crown shade. Beds and misting poles add Gaussian
  bumps like trees (per m² of bed, per pole), saturating. Coating and traffic act on the roadway
  and fade over `fade_m` beside it. The coating's reflected sun adds to the felt temperature on
  the road and `sidewalk_m` beside it, scaled with sun height like shade.
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
`pm` or `noise` in `config/overlays.json`. Particulate matter and noise are modelled for trees;
of the other measures only "speed limit & less traffic" changes them: the noise map by the panel's
dB(A) change (at most −20 dB when car-free), particulate matter as described below. The rest
leave PM and noise unchanged, and the panel says so.

### Traffic and particulate matter (a conservative approximation)

No study gives the share of a street's particulate matter that comes from its own traffic for
every street in Heilbronn, so the model estimates it from the city's two permanent stations:
the traffic station DEBW152 Weinsberger Straße-Ost (OSM class `primary`) and the urban background
station DEBW015. Their difference is the part the street adds on top of what reaches it from the
rest of the city and the region. Annual means in µg/m³ from the
[UBA air data API](https://luftdaten.umweltbundesamt.de/api/air-data/v3/annualbalances/json?component=1&year=2024&lang=en)
(component 1 = PM10, 9 = PM2.5):

| Year | PM10 traffic | PM10 background | difference | PM2.5 traffic | PM2.5 background | difference |
|---|---|---|---|---|---|---|
| 2016 | 24 | 20 | 4 | 15 | 13 | 2 |
| 2017 | 24 | 20 | 4 | 14 | 13 | 1 |
| 2018 | 25 | 20 | 5 | 14 | 12 | 2 |
| 2019 | 22 | 18 | 4 | 12 | 11 | 1 |
| 2020 | 17 | 16 | 1 | 9.8 | 9.2 | 0.6 |
| 2021 | 15 | 16 | −1 | 8.9 | 9.0 | −0.1 |
| 2022 | 17 | 16 | 1 | 9.9 | 9.5 | 0.4 |
| 2023 | 15 | 13 | 2 | 8.3 | 7.7 | 0.6 |
| 2024 | 16 | 14 | 2 | 8.7 | 8.0 | 0.7 |
| 2025 | 17 | 16 | 1 | 9.9 | 9.4 | 0.5 |

The difference has shrunk from 4–5 µg/m³ PM10 before 2020 to 1–2 µg/m³ since. The model uses the
recent years (2022–2025; 2020–21 left out for the pandemic): about **9 % of PM10 and 6 % of PM2.5**
at the traffic station come from the street itself (`measures.traffic.pm_traffic_share`).

How it is applied, and why it is conservative:

* Removing a share of the traffic removes the same share of that street part, nothing more. Most
  traffic particles today come from brakes, tyres and road dust, not exhausts (Harrison et al. 2021),
  so they scale with the number of vehicles, and electric cars would change little.
* Traffic volumes per street are not known; the share is scaled linearly by the vehicles per day
  assumed for the road class, relative to a `primary` road (`pm_reference_vehicles_per_day`).
  Busier roads are capped at the measured share instead of extrapolated.
* Tempo 30 alone changes nothing (`pm_factor_30` = 1): studies range from no lower exhaust
  emissions (LUBW, Stuttgart) to about −2 ± 3 %, and the possible drop in road dust and brake wear
  is not quantified.
* The station difference is an upper bound for local traffic in one way (other sources near the
  station count too) and a lower bound in another (the background station also sees some traffic).
  We have not found a source apportionment for PM at Weinsberger Straße; the clean air plan
  (Luftreinhalteplan 2020) only breaks down NO₂, where road traffic accounts for 66 %.
* For comparison, Berlin around 2000 had up to 40 % more PM10 at main streets than in the background
  (Lenschow et al. 2001), with older vehicles. The Heilbronn numbers are the relevant ones today.

Example: halving the traffic on a main road lowers PM10 there by about 4.5 %, on a residential
street (1,000 vehicles a day assumed) by about 0.3 %.

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
* Middel, Selover, Hagen & Chhetri (2016), [Impact of shade on outdoor thermal comfort](https://pmc.ncbi.nlm.nih.gov/articles/PMC5127889/):
  a shade canopy felt as cool as tree shade.
* Armson, Stringer & Ennos (2012), [The effect of tree shade and grass on surface and globe temperatures in an urban area](https://doi.org/10.1016/j.ufug.2012.05.002):
  grass cools the ground by up to 24 °C but hardly the felt temperature.
* Middel et al. (2020), [Solar reflective pavements—A policy panacea to heat mitigation?](https://doi.org/10.1088/1748-9326/ab87d4):
  coated streets 4–6 °C cooler at the surface, air 0.5 °C, but 4 °C more radiant heat on pedestrians at midday.
* Ulpiani (2019), [Water mist spray for outdoor cooling: A systematic review](https://doi.org/10.1016/j.apenergy.2019.113340).
* Umweltbundesamt (2016), [Lärm- und Klimaschutz durch Tempo 30](https://www.umweltbundesamt.de/sites/default/files/medien/378/publikationen/texte_30_2016_kurz_laerm-_und_klimaschutz_durch_tempo_30_0.pdf):
  1–4 dB(A) less noise on main roads.
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

## Street view (Weipertstraße)

`street.html` (linked from the map's left panel and its flag on Weipertstraße) shows the street
in front of the Open Space from the centre of the road, looking north and looking south. Click
the footpath to plant a small, medium or large tree, or the road to place a car; with **Remove**,
click a tree's trunk or a car to take it away. Trees only go behind the kerb, cars only between the
kerbs, and neither too close to its own kind: crowns may overlap by at most
`placement.crown_overlap` of their radii (as on the map), and cars keep 1 m in front and behind and
0.5 m beside. Objects get the size and position the perspective gives at that spot and
nearer objects cover farther ones; cars keep to the right, so they are seen from behind, from
the front or from the side. Tree shadows follow the sun for the chosen date and time (the panel
says where the sun stands and where shadows fall), and so does the light: warm low sun around
sunrise and sunset, blue dusk, and night with car head- and tail lights once the sun is 8° below
the horizon (the time slider covers the whole day). **Save
image** downloads the view, **Show trees on the map** hands the planted trees to the map, which
selects Weipertstraße there, plants them by hand and computes the cooling.

Both views share one street: what you place is stored in metres from the common camera point,
so it shows in whichever view looks its way, counts for spacing in both, and **Remove all** clears
the street. As on the map, a panel on the right (once something is placed) gives the mean
temperature before and with the trees within
`street_corridor_m` of the centre line, 3–60 m in both directions, so both views show the same
numbers (the map's tree model: shade by date and time, plus
evaporation, on a base temperature), the strongest cooling and the shaded area, and below it NO₂
and PM2.5 before and with the cars and trees: a background value plus a plume per car along its
lane, lowered a little under tree crowns. All numbers are in `street_view` in `config/model.json`;
they are illustrative estimates, not measurements.

The views and the trees and cars are AI images (see below). Each view's calibration in
`centre_views` in `config/street.json`: `horizon_y` and `vanishing_x` are where the street's
lines meet, the camera stands on the centre line 2 m above the road at `lat`/`lon`, and
`focal_px` assumes a 70° horizontal field of view, and `kerbs` marks one point on each kerb,
which sets where the footpath begins. Open `street.html?debug` to see a ground grid
(1 m lines along the street, 5 m across) and check it against the kerbs.

### Trees and cars

`scripts/make_sprites.py` makes the cut-outs in `data/street/sprites/` with the same open model:
two trees per size (the presets in `config/model.json`) and three cars each from behind, the
front and the side, painted on magenta and keyed out. `sprites.json` gives each one's ground
point and pixels per metre.

```bash
python scripts/make_sprites.py                 # all 15, about 30 s each
python scripts/make_sprites.py car-side-2 --seed 4   # redo one
```

### The views

The two views show Weipertstraße looking north and looking south from the centre line, as it is
today: the same buildings, trees, bus stop and markings, on
the same overcast autumn day, nothing added. The photos were taken from the pavement, so
`scripts/centre_view.py` has the open model
[Qwen-Image-Edit-2511](https://huggingface.co/Qwen/Qwen-Image-Edit-2511) (Apache 2.0) reconstruct
that viewpoint from the north and south photos in `data/street/`. The brief is in the script; what
each direction shows (which side has the bus stop, where there are no trees) is in `centre_views`
in `config/street.json`. The street is recognisable, small details are the model's: an AI image,
not a photo. It needs a GPU with about 60 GB:

```bash
pip install torch torchvision diffusers transformers accelerate pillow
python scripts/centre_view.py                 # both views, about 70 s each
python scripts/centre_view.py north --seed 7  # another take of one
```

On a GH200 (ARM) load the model from a local disk (`--model /local/copy`): the script reads the
weight files whole, because moving memory-mapped weights to the GPU is extremely slow there.

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
| `data/street/*.jpg` | own photos of Weipertstraße, 28 Oct 2026 | the team's |
| `data/street/centre/*.jpg`, `data/street/sprites/*.png` | generated with Qwen-Image-Edit-2511, the views from those photos | model: Apache 2.0 |
| Basemap | © OpenStreetMap contributors, © CARTO | ODbL / CARTO terms |

Citizen temperature sensors are often unshaded and read several degrees above the
meteorological air temperature on sunny days.
