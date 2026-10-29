'use strict';
// Map, data loading, street selection, tree placement and UI.
// Physics: model.js. Rasterising: worker.js. Everything configurable: config/*.json.

const BASEMAPS = {  // same tiles and layer schema, only the colours differ
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};
const THEME_PAINT = {  // our own layers that need different colours on a dark map
  light: {shadows: {'fill-color': '#102030', 'fill-opacity': 0.3}, section: {'line-opacity': 0.3},
          'buildings-3d': {'fill-extrusion-color': '#e4dfd6'}},
  dark: {shadows: {'fill-color': '#000000', 'fill-opacity': 0.5}, section: {'line-opacity': 0.45},
         'buildings-3d': {'fill-extrusion-color': '#3d4148'}},
};
const OWN_SOURCES = ['heat', 'section', 'measure', 'shadows', 'planted', 'lasso', 'hotspots', 'trees-3d'];
const RAMP = ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#b10026'];
const STITCH_TOLERANCE_M = 2;
const MIN_SELECT_ZOOM = 14.5;
const HOTSPOT_ZOOM = 17;
const HOTSPOT_SECTION_M = 200;  // section preselected around a hotspot
const STREET_HANDOFF_KEY = 'ng-street-handoff';  // trees planted in street.html
const STREET_VIEW_CFG = 'config/street.json';     // photo views of street.html

const $ = id => document.getElementById(id);
const S = {
  cfg: null, model: null, map: null, popup: null,
  overlay: null, records: [], hasTime: false, extent: null, domain: null,   // heat overlay
  roadLayers: [], roadSource: null, theme: 'light', view3d: false,
  street: null,          // {name, kind, line, xy, cum, length, halfWidth, obstacles, a, b}
  measure: 'trees',      // config/model.json measures: 'trees' | 'beds' | 'pavement' | 'misting' | 'traffic'
  mode: 'even',          // tree placement: 'even' | 'manual'
  manual: [],            // [{lon, lat}] trees placed by hand
  placement: {key: null, trees: []}, layout: {key: null},  // cached tree placement, other measures' layout
  draw: {active: false, drawing: false, ring: []},
  layerData: {}, existingTrees: [], icons: {}, iconTheme: null, canyon: null,
  job: 0, timer: null, refresh: null, url: null,
};
let worker = null;  // started in main() once its files are known to be current

// The simple dev server lets browsers keep old copies. Revalidate the worker's files first
// (a cheap "304 not modified" when unchanged), so a stale worker.js or model.js is never mixed
// with a newer app.js; the worker then loads them from the refreshed cache.
async function startWorker() {
  await Promise.all(['worker.js', 'model.js'].map(url => fetch(url, {cache: 'no-cache'}).catch(() => null)));
  worker = new Worker('worker.js');
  worker.onmessage = onWorkerResult;
}

async function main() {
  [S.cfg, S.model] = await Promise.all([getJSON('config/overlays.json'), getJSON('config/model.json'), startWorker()]);
  S.theme = initialTheme();
  document.documentElement.dataset.theme = S.theme;
  S.map = new maplibregl.Map({container: 'map', style: BASEMAPS[S.theme], center: S.cfg.center, zoom: S.cfg.zoom, hash: true});
  S.map.addControl(new maplibregl.NavigationControl({showCompass: false}), 'top-right');
  S.map.addControl(new ThemeControl(), 'top-right');
  if (Object.keys(iconThemes()).length) S.map.addControl(new SeasonControl(), 'top-right');
  setupGeolocate();
  S.map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
  await S.map.once('style.load');  // don't wait for every basemap tile
  await loadIcons();
  setupMap();
  setupUi();
  setupDataLayers();
  loadHotspots();
  setupStreetView();
  loadCanyonScenarios();
  await loadOverlay(S.cfg.overlays[0]);
  await applyStreetHandoff();
}

// Trees planted in the street view (street.html) arrive through localStorage: select that
// street around them and plant them by hand, with the street view's date and time.
async function applyStreetHandoff() {
  if (!new URLSearchParams(location.search).has('from')) return;
  let h = null;
  try { h = JSON.parse(localStorage.getItem(STREET_HANDOFF_KEY)); } catch { /* nothing handed over */ }
  history.replaceState(null, '', location.pathname + location.hash);
  if (!h || !h.trees || !h.trees.length) return;
  if (h.date) $('date').value = h.date;
  if (h.time != null) $('time').value = h.time;
  if (S.model.presets[h.preset]) $('preset').value = h.preset;
  S.map.jumpTo({center: h.at, zoom: 18});
  await new Promise(r => S.map.once('idle', r));
  const found = streetAt(S.map.project(h.at), h.at, 40, h.street);
  if (!found) return setStatus(`${h.street} not found on the map, the trees were not placed.`, true);
  const P = NG.projection(...S.cfg.center), g = measure(found.line, P);
  const at = h.trees.map(t => { const {x, y} = P.toXY(t.lon, t.lat); return locate(g, x, y); });
  selectStreet(found.hit, found.line, Math.min(...at) - 15, Math.max(...at) + 15);
  setMeasure('trees');
  document.querySelector('input[name=mode][value=manual]').checked = true;
  setMode('manual');
  S.manual = h.trees.map(({lon, lat}) => ({lon, lat}));
  update();
}

// ------------------------------------------------------------------ map setup

// Where our layers go in a basemap style: the heat raster below the roads, the scenario
// above roads and buildings but below the labels.
function anchors(layers) {
  const roads = layers.filter(l => l['source-layer'] === 'roads' && l.type === 'line' && !/rail|aeroway/.test(l.id));
  const firstRoad = roads[0].id;
  const firstLabel = layers.slice(layers.findIndex(l => l.id === firstRoad)).find(l => l.type === 'symbol').id;
  return {roads, firstRoad, firstLabel};
}

function setupMap() {
  const m = S.map, layers = m.getStyle().layers;
  const {roads, firstRoad, firstLabel} = anchors(layers);
  S.roadLayers = roads.map(l => l.id);
  S.roadSource = roads[0].source;

  m.addSource('heat', {type: 'image', url: blankPng(), coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]]});
  m.addLayer({id: 'heat', type: 'raster', source: 'heat', paint: {'raster-opacity': 0.72, 'raster-fade-duration': 0}}, firstRoad);

  for (const id of ['section', 'measure', 'shadows', 'planted', 'lasso']) m.addSource(id, {type: 'geojson', data: fc([])});
  m.addLayer({id: 'section', type: 'line', source: 'section', layout: {'line-cap': 'round'},
              paint: {'line-color': '#1c7ed6', ...THEME_PAINT[S.theme].section, 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 14, 4, 20, 90]}}, firstLabel);
  m.addLayer({id: 'lasso', type: 'line', source: 'lasso',
              paint: {'line-color': '#1c7ed6', 'line-width': 2, 'line-dasharray': [2, 2]}}, firstLabel);
  m.addLayer({id: 'measure', type: 'fill', source: 'measure', filter: ['==', ['geometry-type'], 'Polygon'],
              paint: {'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'opacity'], 'fill-outline-color': ['get', 'outline']}}, firstLabel);
  m.addLayer({id: 'shadows', type: 'fill', source: 'shadows', paint: {...THEME_PAINT[S.theme].shadows}}, firstLabel);
  m.addLayer(S.icons.planted  // same scale and minimum size as the existing trees, so both compare 1:1
    ? iconLayer('planted', 'planted', ['*', 2, ['get', 'r']], 10, 1)
    : {id: 'planted', type: 'circle', source: 'planted', paint: {
        'circle-color': '#2f9e44', 'circle-opacity': 0.9, 'circle-stroke-color': '#0b3d16', 'circle-stroke-width': 1.5,
        'circle-radius': metres(['get', 'r'], 4)}}, firstLabel);

  const font = layers.find(l => l.layout && l.layout['text-font'])?.layout['text-font'];
  m.addSource('hotspots', {type: 'geojson', data: fc([])});
  m.addLayer({id: 'hotspots', type: 'circle', source: 'hotspots', paint: {
    'circle-radius': 9, 'circle-color': '#c92a2a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2}});
  m.addLayer({id: 'hotspot-labels', type: 'symbol', source: 'hotspots', layout: {
    'text-field': ['to-string', ['get', 'rang']], 'text-font': font, 'text-size': 11, 'text-allow-overlap': true},
    paint: {'text-color': '#fff'}});
  m.addLayer({id: 'measure-labels', type: 'symbol', source: 'measure', filter: ['==', ['geometry-type'], 'Point'], layout: {
    'text-field': ['get', 'label'], 'text-font': font, 'text-size': 15, 'text-allow-overlap': true, 'text-offset': [0, -1.6]},
    paint: {'text-color': '#c92a2a', 'text-halo-color': '#fff', 'text-halo-width': 2}}, 'hotspots');

  S.popup = new maplibregl.Popup({closeButton: false, closeOnClick: false, offset: 10, maxWidth: '260px'});
  m.on('moveend', update);
  m.on('click', onClick);
  m.on('mousemove', e => {
    if (S.draw.active) return;
    const layers = manualTrees() ? ['planted'] : S.roadLayers;
    const hit = m.getZoom() >= MIN_SELECT_ZOOM && m.queryRenderedFeatures(box(e.point, 10), {layers}).length;
    m.getCanvas().style.cursor = hit ? 'pointer' : manualTrees() ? 'copy' : '';
  });
  for (const [down, move, up] of [['mousedown', 'mousemove', 'mouseup'], ['touchstart', 'touchmove', 'touchend']]) {
    m.on(down, lassoStart);
    m.on(move, lassoMove);
    m.on(up, lassoEnd);
  }
}

function setupUi() {
  for (const o of S.cfg.overlays) $('overlay').add(new Option(o.label, o.id));
  $('overlay').onchange = e => loadOverlay(S.cfg.overlays.find(o => o.id === e.target.value));
  for (const [k, p] of Object.entries(S.model.presets)) $('preset').add(new Option(p.label, k));
  $('preset').value = S.model.default_preset;
  $('trees').max = S.model.max_trees;
  $('trees').value = S.model.default_trees;
  $('date').value = new Date().toISOString().slice(0, 10);
  const ms = S.model.measures;
  for (const k of ms.order) $('measure').add(new Option(ms[k].label, k));
  $('measure').onchange = e => setMeasure(e.target.value);
  const range = (id, [value, min, max]) => Object.assign($(id), {min, max, value});
  range('bedWidth', ms.beds.width_m);
  range('albedo', ms.pavement.albedo);
  range('poles', [ms.misting.poles[0], 0, ms.misting.poles[1]]);
  range('sails', [ms.sails.sails[0], 0, ms.sails.sails[1]]);
  for (const r of document.querySelectorAll('input[name=sailSpan]')) r.onchange = update;
  for (const id of ['date', 'time', 'trees', 'preset', 'sails', 'bedWidth', 'bedShare', 'albedo', 'poles', 'speed', 'volume']) $(id).oninput = update;
  setupSourceTips();
  setMeasure(S.measure);
  for (const r of document.querySelectorAll('input[name=mode]')) r.onchange = () => setMode(r.value);
  $('clearTrees').onclick = () => { S.manual = []; update(); };
  $('drawBtn').onclick = () => setDrawMode(!S.draw.active);
  $('close').onclick = closeScenario;
  $('view3d').onclick = () => set3D(!S.view3d);
  addEventListener('keydown', e => { if (e.key === 'Escape') setDrawMode(false); });
}

function onClick(e) {
  if (S.draw.active) return;
  if (manualTrees()) return toggleManualTree(e);
  pickStreet(e);
}

const manualTrees = () => S.street && S.measure === 'trees' && S.mode === 'manual';

// ------------------------------------------------------------------ light / dark theme

function initialTheme() {
  try { const saved = localStorage.getItem('theme'); if (saved === 'light' || saved === 'dark') return saved; } catch {}
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Swap the basemap and carry all our sources and layers over at the same positions,
// so data, selection, trees and the heat image survive without reloading anything.
function setTheme(theme) {
  if (theme === S.theme) return;
  S.theme = theme;
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('theme', theme); } catch {}
  S.themeButton?.update();
  S.map.setStyle(BASEMAPS[theme], {transformStyle: (prev, next) => {
    if (!prev) return next;
    const own = id => OWN_SOURCES.includes(id) || id.startsWith('lyr-');
    const sources = {...next.sources};
    for (const [id, src] of Object.entries(prev.sources)) if (own(id)) sources[id] = src;
    // our layers, plus the 3D buildings (drawn from the basemap's tiles, which both styles share)
    const mine = prev.layers.filter(l => own(l.source || '') || l.id === 'buildings-3d');
    const restyle = l => ({...l, paint: {...l.paint, ...(THEME_PAINT[theme][l.id] || {})}});
    const below = mine.filter(l => l.id === 'heat');
    const top = mine.filter(l => l.source === 'hotspots');
    const middle = mine.filter(l => !below.includes(l) && !top.includes(l)).map(restyle);
    const layers = [...next.layers];
    const {firstRoad} = anchors(layers);
    layers.splice(layers.findIndex(l => l.id === firstRoad), 0, ...below);
    const {firstLabel} = anchors(layers);
    layers.splice(layers.findIndex(l => l.id === firstLabel), 0, ...middle);
    return {...next, sources, layers: [...layers, ...top]};
  }});
  S.map.once('style.load', () => {
    const {roads} = anchors(S.map.getStyle().layers);
    S.roadLayers = roads.map(l => l.id);
    S.roadSource = roads[0].source;
    if (S.view3d) add3DLayers();
  });
}

class ThemeControl {
  onAdd() {
    const div = document.createElement('div'), btn = document.createElement('button');
    div.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.onclick = () => setTheme(S.theme === 'dark' ? 'light' : 'dark');
    this.update = () => {
      const dark = S.theme === 'dark';
      btn.title = btn.ariaLabel = dark ? 'Switch to light map' : 'Switch to dark map';
      btn.innerHTML = dark  // icon shows what you get: sun in dark mode, moon in light mode
        ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    };
    this.update();
    S.themeButton = this;
    div.append(btn);
    return div;
  }
  onRemove() {}
}

// ------------------------------------------------------------------ your location
// Browsers only allow it on https or localhost and after permission; say why when it fails,
// instead of the control's silent grey button. Wi-Fi positioning is enough and much faster on laptops.

function setupGeolocate() {
  const ctl = new maplibregl.GeolocateControl({positionOptions: {enableHighAccuracy: false, timeout: 15000, maximumAge: 60000},
                                              fitBoundsOptions: {maxZoom: 17}});
  S.map.addControl(ctl, 'top-right');
  ctl.on('geolocate', e => setStatus(`Your location: ±${Math.round(e.coords.accuracy)} m.`));
  ctl.on('error', e => setStatus(
    !isSecureContext ? 'Your location needs the page on https or localhost (e.g. http://localhost:8765), not a network address.'
      : e.code === 1 ? 'Location access is blocked: allow it for this page in the browser (and for the browser in the system settings).'
      : e.code === 3 ? 'Your location took too long to find. Try again.'
      : 'Your location is not available on this device right now.', true));
  ctl.on('outofmaxbounds', () => setStatus('Your location is outside the map area.', true));
  if (!isSecureContext) {
    const b = document.querySelector('.maplibregl-ctrl-geolocate');
    if (b) b.title = 'Your location needs the page on https or localhost';
  }
}

// ------------------------------------------------------------------ street view (street.html)
// A flag at the road centre where the street view stands; clicking it opens the street view.

async function setupStreetView() {
  try { S.streetView = await getJSON(STREET_VIEW_CFG); } catch { return; }
  const cfg = S.streetView, views = cfg.centre_views;
  const at = [views.reduce((a, v) => a + v.lon, 0) / views.length, views.reduce((a, v) => a + v.lat, 0) / views.length];
  const el = document.createElement('button');
  el.className = 'flag';
  el.title = `Open the street view of ${cfg.street}`;
  el.innerHTML = '<svg viewBox="0 0 24 32" width="24" height="32"><path d="M4 2v28" stroke="#1d2329" stroke-width="2.5" stroke-linecap="round"/>' +
                 '<path d="M5 3h15l-4 5 4 5H5z" fill="#1c7ed6" stroke="#fff" stroke-width="1"/></svg><span>Street view</span>';
  el.addEventListener('click', e => { e.stopPropagation(); location.href = 'street.html'; });
  S.flag = new maplibregl.Marker({element: el, anchor: 'bottom-left', offset: [-4, 0]}).setLngLat(at).addTo(S.map);
  $('findStreetView').onclick = e => {
    e.preventDefault();
    S.map.flyTo({center: at, zoom: Math.max(S.map.getZoom(), 17.5)});
  };
}

// ------------------------------------------------------------------ street selection: click

// Click a street: select all of it (as far as it is loaded).
function pickStreet(e) {
  if (S.map.getZoom() < MIN_SELECT_ZOOM) return setStatus('Zoom in further to select a street.');
  const found = streetAt(e.point, [e.lngLat.lng, e.lngLat.lat]);
  if (found) selectStreet(found.hit, found.line, 0, Infinity);
}

// The street under a screen point (preferring `name`, then any named street) and its joined line nearest to lngLat.
function streetAt(point, lngLat, radius = 10, name = null) {
  const hits = S.map.queryRenderedFeatures(box(point, radius), {layers: S.roadLayers});
  const hit = hits.find(f => name && f.properties.name === name) || hits.find(f => f.properties.name) || hits[0];
  if (!hit) return null;
  const line = streetLines(hit).sort((a, b) => turf.pointToLineDistance(lngLat, a) - turf.pointToLineDistance(lngLat, b))[0];
  return line ? {hit, line} : null;
}

// ------------------------------------------------------------------ hotspots

// Warm street spots found in the bike rides by scripts/find_hotspots.py. A click flies there,
// selects the street and preselects HOTSPOT_SECTION_M around the hotspot.
async function loadHotspots() {
  if (!S.cfg.hotspots) return;
  let gj;
  try { gj = await getJSON(S.cfg.hotspots); } catch { return; }
  setData('hotspots', gj);
  $('hotspots').replaceChildren(...gj.features.map(f => {
    const p = f.properties, li = document.createElement('li'), b = document.createElement('button');
    const name = document.createElement('span'), val = document.createElement('b');
    name.textContent = `${p.rang}. ${p.strasse}`;
    val.textContent = `${signed(p.anomalie_K)} °C`;
    b.title = `${p.fahrten} rides by ${p.raeder} bikes, mean ${p.temperatur_mittel} °C (± ${p.fehler_K} °C)`;
    b.append(name, val);
    b.onclick = () => goToHotspot(f);
    li.append(b);
    return li;
  }));
  const day = s => new Date(`${s}T12:00:00Z`).toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric'});
  $('hotspotNote').textContent = 'Warmer than the rest of the same ride' + (gj.meta ? `, ${day(gj.meta.von)} – ${day(gj.meta.bis)}` : '') + '.';
  $('hotspotBox').hidden = false;
}

function goToHotspot(f) {
  const ll = f.geometry.coordinates;
  S.map.flyTo({center: ll, zoom: Math.max(S.map.getZoom(), HOTSPOT_ZOOM)});
  S.map.once('idle', () => {
    const found = streetAt(S.map.project(ll), ll, 25, f.properties.strasse);
    if (!found) return setStatus('No street found at the hotspot, please click it directly.', true);
    const P = NG.projection(...S.cfg.center), {x, y} = P.toXY(ll[0], ll[1]), at = locate(measure(found.line, P), x, y);
    selectStreet(found.hit, found.line, at - HOTSPOT_SECTION_M / 2, at + HOTSPOT_SECTION_M / 2);
  });
}

// ------------------------------------------------------------------ canyon scenarios
// Results of section 7 of street_tree_cooling_model.ipynb (a street-canyon box model of
// canyon-average air temperature at peak hour), shown in the scenario panel. Pick a scenario
// in the dropdown or click its bar; the notebook regenerates the file.

const CANYON_PARTS = [  // same colours as the notebook's chart; sources: config/model.json parts, as in the notebook's section 1
  ['dT_shade', 'Shade', '#2b8cbe', ['canyon_shade', 'canyon_box']],
  ['dT_crown', 'Crown heat', '#fdae6b', ['canyon_crown', 'canyon_box']],
  ['dT_ventilation', 'Less ventilation', '#e6550d', ['canyon_ventilation', 'canyon_box']],
];
const INPUT_LABELS = {U: ['wind', 'm/s'], LE_crown: ['transpiration', 'W/m²'], c_d: ['drag c_d', ''],
                      spacing: ['tree spacing', 'm'], d_crown: ['crown', 'm'], W: ['street width', 'm']};

async function loadCanyonScenarios() {
  if (!S.cfg.canyonScenarios) return;
  try { S.canyon = await getJSON(S.cfg.canyonScenarios); } catch { return; }
  const sel = $('canyonScenario');
  for (const sc of S.canyon.scenarios) sel.add(new Option(sc.label, sc.id));
  sel.onchange = () => renderCanyon(sel.value);
  const b = S.canyon.base;
  $('canyonNote').textContent = `Base case: street ${b.W} m wide, ${b.H} m high, ${b.K_down} W/m² sun, wind ${b.U} m/s at roof level, ` +
    `${b.T_above} °C above the roofs; crowns ${b.d_crown} m every ${b.spacing} m. Each scenario changes only the inputs it lists. ` +
    'Canyon-average air temperature, so smaller than the felt-temperature change above. From street_tree_cooling_model.ipynb.';
  renderCanyon(S.canyon.scenarios[0].id);
  layoutView();
}

function renderCanyon(id) {
  const all = S.canyon.scenarios, sc = all.find(s => s.id === id), o = sc.outputs;
  $('canyonScenario').value = id;
  S.canyonId = id;
  renderSummaries();
  const changes = Object.entries(sc.changes).map(([k, v]) => {
    const [name, unit] = INPUT_LABELS[k] || [k, ''];
    return `${name} ${v}${unit ? ' ' + unit : ''} (base ${S.canyon.base[k]})`;
  });
  const degC = v => `${signed(v, 2)} °C`;  // differences: 1 K = 1 °C
  $('canyonChanges').textContent = changes.length ? `Changed: ${changes.join(', ')}` : 'Base case, nothing changed';
  $('canyonResult').innerHTML = [
    ['Crown cover', `${Math.round(o.crown_cover * 100)} % of width`],
    ...CANYON_PARTS.map(([k, label, colour, ids]) => [`<i class="swatch" style="background:${colour}"></i>` +
      `<button type="button" class="src srclabel" data-src="${ids.join(' ')}" aria-label="${label}: sources">${label}<span class="srcicon">i</span></button>`, degC(o[k])]),
    ['Net tree effect', degC(o.dT_total), o.dT_total > 0 ? 'big warm' : 'big'],
    ['Canyon air', `${o.T_can_no_trees.toFixed(1)} → ${o.T_can_trees.toFixed(1)} °C`],
  ].map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ''}">${v}</dd>`).join('') +
    o.warnings.map(w => `<dt class="err" style="grid-column:1/-1">${esc(w)}</dt>`).join('');

  // All scenarios on one axis: cooling parts to the left of zero, warming parts to the right.
  const lo = Math.min(0, ...all.map(s => s.outputs.dT_shade)), hi = Math.max(0, ...all.map(s => s.outputs.dT_crown + s.outputs.dT_ventilation));
  const pct = v => ((v - lo) / (hi - lo)) * 100;
  const bar = (a, b, colour) => `<i style="left:${pct(Math.min(a, b))}%;width:${pct(Math.max(a, b)) - pct(Math.min(a, b))}%;background:${colour}"></i>`;
  $('canyonChart').replaceChildren(...all.map(s => {
    const q = s.outputs, row = document.createElement('button');
    row.className = s.id === id ? 'active' : '';
    row.title = `${s.label}: net ${degC(q.dT_total)}`;
    row.innerHTML = `<span>${esc(s.label.split(' (')[0])}</span><span class="track">` +
      `<i class="zero" style="left:${pct(0)}%"></i>${bar(0, q.dT_shade, CANYON_PARTS[0][2])}${bar(0, q.dT_crown, CANYON_PARTS[1][2])}` +
      `${bar(q.dT_crown, q.dT_crown + q.dT_ventilation, CANYON_PARTS[2][2])}<i class="net" style="left:${pct(q.dT_total)}%"></i></span>` +
      `<b class="${q.dT_total < 0 ? 'cool' : 'warm'}">${signed(q.dT_total, 2)}</b>`;
    row.onclick = () => renderCanyon(s.id);
    return row;
  }));
}

// Distance along a measured line of the point closest to (x, y).
function locate({xy, cum}, x, y) {
  let best = Infinity, at = 0;
  for (let i = 1; i < xy.length; i++) {
    const a = xy[i - 1], b = xy[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
    if (d < best) { best = d; at = cum[i - 1] + t * Math.sqrt(l2); }
  }
  return at;
}

// ------------------------------------------------------------------ street selection: lasso

function setDrawMode(on) {
  S.draw = {active: on, drawing: false, ring: []};
  $('drawBtn').classList.toggle('active', on);
  $('drawBtn').textContent = on ? 'Cancel drawing' : 'Draw a section';
  S.map.dragPan[on ? 'disable' : 'enable']();
  S.map.getCanvas().style.cursor = on ? 'crosshair' : '';
  if (on) setStatus('Hold the mouse button and draw around the street section.');
}

function lassoStart(e) {
  if (!S.draw.active) return;
  e.preventDefault();
  S.draw.drawing = true;
  S.draw.ring = [[e.lngLat.lng, e.lngLat.lat]];
}

function lassoMove(e) {
  if (!S.draw.drawing) return;
  const last = S.map.project(S.draw.ring[S.draw.ring.length - 1]);
  if (Math.hypot(last.x - e.point.x, last.y - e.point.y) < 4) return;
  S.draw.ring.push([e.lngLat.lng, e.lngLat.lat]);
  setData('lasso', fc([turf.lineString(S.draw.ring.length > 1 ? S.draw.ring : [S.draw.ring[0], S.draw.ring[0]])]));
}

function lassoEnd() {
  if (!S.draw.drawing) return;
  const ring = S.draw.ring;
  setDrawMode(false);
  if (ring.length < 4) return setData('lasso', fc([]));
  setData('lasso', fc([turf.lineString([...ring, ring[0]])]));
  snapToStreet(ring);
}

// The street with the longest stretch inside the drawn shape wins; its stretch becomes the section.
function snapToStreet(ring) {
  const P = NG.projection(...S.cfg.center), poly = [ring.map(c => P.toXY(c[0], c[1]))];
  const px = ring.map(c => S.map.project(c)), xs = px.map(p => p.x), ys = px.map(p => p.y);
  const hits = S.map.queryRenderedFeatures([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], {layers: S.roadLayers});
  const seen = new Set();
  let best = null;
  for (const hit of hits) {
    const key = hit.properties.name || `#${hit.id}-${seen.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const line of streetLines(hit)) {
      const g = measure(line, P);
      let run = null, start = null;
      for (let d = 0; d <= g.length; d += 1) {
        const q = alongXY(g, d), inside = NG.inPolygon(q.x, q.y, poly);
        if (inside && start == null) start = d;
        if ((!inside || d + 1 > g.length) && start != null) {
          const end = inside ? d : d - 1;
          if (!run || end - start > run[1] - run[0]) run = [start, end];
          start = null;
        }
      }
      if (run && (!best || run[1] - run[0] > best.run[1] - best.run[0])) best = {hit, line, run};
    }
  }
  if (!best || best.run[1] - best.run[0] < 5) return setStatus('There is no street inside the drawn area.', true);
  selectStreet(best.hit, best.line, ...best.run);
}

// All loaded pieces of the street that `hit` belongs to, joined into lines.
function streetLines(hit) {
  const name = hit.properties.name;
  const feats = name ? S.map.querySourceFeatures(S.roadSource, {sourceLayer: 'roads', filter: ['==', ['get', 'name'], name]}) : [hit];
  return stitch(feats.flatMap(f => f.geometry.type === 'LineString' ? [f.geometry.coordinates]
                                 : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : []))
    .map(c => turf.lineString(c));
}

function selectStreet(hit, line, a, b) {
  const P = NG.projection(...S.cfg.center), g = measure(line, P);
  S.street = {...g, name: hit.properties.name || 'Unnamed way', line, kind: hit.properties.kind_detail ?? hit.properties.kind,
              halfWidth: roadHalfWidth(hit.properties),
              a: Math.max(0, a), b: Math.min(g.length, b), obstacles: collectObstacles(turf.bbox(line), P)};
  S.manual = [];
  S.placement.key = S.layout.key = null;
  $('street').textContent = S.street.name;
  $('streetViewLink').hidden = !S.streetView || S.street.name !== S.streetView.street;
  $('scenario').hidden = false;
  setStatus('');
  const sec = sectionLine(P);
  if (innerWidth > 900) {  // keep the section clear of both panels, never zoom in
    S.map.fitBounds(turf.bbox(sec), {padding: {top: 80, bottom: 80, left: 320, right: 360}, maxZoom: Math.max(S.map.getZoom(), 17), duration: 600});
  }
  update();
}

// ------------------------------------------------------------------ source tooltips
// An ⓘ button next to a number opens what the model assumes for it next to what studies measured
// (config/model.json "sources", by part id), with links. Hover or focus shows it, a click pins it.

const SOURCE_IDS = {  // per measure: the parts behind its result, by data quantity
  trees: {temperature: ['shade', 'et'], pm: ['pm'], noise: ['noise']},
  sails: {temperature: ['sails']}, beds: {temperature: ['beds']},
  pavement: {temperature: ['pavement']}, misting: {temperature: ['misting']},
  traffic: {temperature: ['traffic'], pm: ['traffic_pm'], noise: ['traffic']},
};

const srcButton = ids => ids?.length ? `<button type="button" class="src" data-src="${ids.join(' ')}" aria-label="Sources">i</button>` : '';

function sourceHtml(ids) {
  const param = path => path.split('.').reduce((o, k) => o?.[k], S.model) ?? `{${path}}`;
  const fill = text => esc(text).replace(/\{([\w.]+)\}/g, (_, path) => esc(String(param(path))));
  const parts = ids.map(id => S.model.sources?.parts.find(p => p.id === id)).filter(Boolean);
  return parts.map(p => `<h3>${esc(p.part)}</h3>
    <p><b>Model:</b> ${fill(p.model)}</p>${p.observed ? `<p><b>Studies:</b> ${esc(p.observed)}</p>` : ''}
    <ol>${p.refs.map(r => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a></li>`).join('')}</ol>`).join('') +
    (parts.length && S.model.sources.note ? `<p class="note">${esc(S.model.sources.note)}</p>` : '');
}

function setupSourceTips() {
  const tip = $('srcTip');
  let owner = null, pinned = false, timer = null;
  const hide = () => { tip.hidden = true; owner?.classList.remove('active'); owner = null; pinned = false; };
  const show = btn => {
    clearTimeout(timer);
    if (owner === btn) return;
    owner?.classList.remove('active');
    owner = btn;
    btn.classList.add('active');
    tip.innerHTML = sourceHtml(btn.dataset.src.split(' '));
    tip.hidden = false;
    const r = btn.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
    tip.style.top = `${r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  };
  const later = () => { if (!pinned) timer = setTimeout(hide, 250); };
  document.addEventListener('mouseover', e => { const b = e.target.closest?.('.src'); if (b) show(b); });
  document.addEventListener('mouseout', e => { if (e.target.closest?.('.src')) later(); });
  document.addEventListener('focusin', e => { const b = e.target.closest?.('.src'); if (b) show(b); });
  tip.addEventListener('mouseenter', () => clearTimeout(timer));
  tip.addEventListener('mouseleave', later);
  document.addEventListener('click', e => {
    const b = e.target.closest?.('.src');
    if (b) { if (owner === b && pinned) hide(); else { show(b); pinned = true; } return; }
    if (!tip.contains(e.target)) hide();
  });
  addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
  $('scenario').addEventListener('scroll', hide);
}

function closeScenario() {
  if (S.view3d) set3D(false);
  S.street = null;
  S.manual = [];
  $('scenario').hidden = true;
  setData('lasso', fc([]));
  update();
}

function stitch(lines) {
  const opts = {units: 'meters'};
  const near = (pt, coords) => turf.pointToLineDistance(pt, turf.lineString(coords), opts) <= STITCH_TOLERANCE_M;
  // drop duplicates and pieces fully contained in another piece (tile buffers overlap)
  const kept = [];
  for (const l of lines.filter(l => l.length > 1).sort((a, b) => b.length - a.length)) {
    if (!kept.some(o => l.every(p => near(p, o)))) kept.push(l);
  }
  lines = kept;
  const join = (a, b) => {
    for (const A of [a, [...a].reverse()]) for (const B of [b, [...b].reverse()]) {
      const np = turf.nearestPointOnLine(turf.lineString(B), A[A.length - 1], opts);
      if (np.properties.dist > STITCH_TOLERANCE_M || !near(B[0], A)) continue;
      return [...A, ...B.slice(np.properties.index + 1)];
    }
    return null;
  };
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < lines.length; i++) for (let j = 0; j < lines.length; j++) {
      if (i === j) continue;
      const joined = join(lines[i], lines[j]);
      if (joined) { lines[i] = joined; lines.splice(j, 1); merged = true; break outer; }
    }
  }
  return lines;
}

// Line in local metres with cumulative distances.
function measure(line, P) {
  const xy = line.geometry.coordinates.map(c => P.toXY(c[0], c[1]));
  const cum = xy.map((q, i) => (i ? Math.hypot(q.x - xy[i - 1].x, q.y - xy[i - 1].y) : 0));
  for (let i = 1; i < cum.length; i++) cum[i] += cum[i - 1];
  return {xy, cum, length: cum[cum.length - 1]};
}

// Point and unit tangent at distance d along a measured line.
function alongXY({xy, cum}, d) {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const a = xy[i - 1], b = xy[i], len = cum[i] - cum[i - 1] || 1, t = Math.max(0, Math.min(1, (d - cum[i - 1]) / len));
  return {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, tx: (b.x - a.x) / len, ty: (b.y - a.y) / len};
}

function sectionLine(P) {
  const st = S.street;
  const b = Math.max(st.b, Math.min(st.length, st.a + 5));
  const pts = [alongXY(st, st.a), ...st.xy.filter((_, i) => st.cum[i] > st.a && st.cum[i] < b), alongXY(st, b)];
  return turf.lineString(pts.map(q => P.toLL(q.x, q.y)));
}

// ------------------------------------------------------------------ tree placement
// Trees go to the kerb and only where there is room: not on a road (width estimated
// from its class), not inside a building or water, not under an existing or another new crown.

function setMode(mode) {
  if (mode === 'manual' && S.mode === 'even') S.manual = S.placement.trees.map(({lon, lat}) => ({lon, lat}));
  S.mode = mode;
  $('evenCtl').hidden = mode !== 'even';
  $('manualCtl').hidden = mode !== 'manual';
  update();
}

function currentTrees(P) {
  const size = S.model.presets[$('preset').value];
  const withSize = t => ({lon: t.lon, lat: t.lat, height_m: size.height_m, crown_diameter_m: size.crown_diameter_m});
  if (S.mode === 'manual') return S.manual.map(withSize);
  const n = +$('trees').value, key = [S.street.a, S.street.b, n, $('preset').value, S.existingTrees.length].join('|');
  if (S.placement.key !== key) {
    const {trees, alreadyTreed} = placeEvenly(n, size.crown_diameter_m / 2, P);
    S.placement = {key, trees: trees.map(withSize), alreadyTreed};
  }
  return S.placement.trees;
}

// Evenly spaced on alternating sides. A blocked spot first moves away from the centre line
// (real streets are often wider than their class suggests, e.g. tram tracks in a pedestrian
// zone) but never past a building or water, then slides along the street until one fits.
//
// An existing tree claims its side of the street for the stretch around it: a slot whose side
// already has a tree within half a spacing goes to the other side, and is skipped when both
// sides have one (placement.existing_trees_claim_side).
//
// avoidTrees = false (e.g. misting poles): existing trees neither block a spot nor claim a side.
function placeEvenly(n, r, P, avoidTrees = true) {
  const st = S.street, pl = S.model.placement, placed = [];
  const start = (st.halfWidth || pl.path_offset_m) + pl.clearance_m + 0.5;
  const spacing = (st.b - st.a) / Math.max(n, 1), reach = Math.max(2, spacing / 2);
  const existing = avoidTrees && pl.existing_trees_claim_side ? existingAlongStreet(st, pl.max_offset_m) : [];
  const obstacles = avoidTrees ? st.obstacles : {roads: st.obstacles.roads, buildings: st.obstacles.buildings, trees: []};
  let alreadyTreed = 0;
  for (let i = 0; i < n; i++) {
    const d0 = st.a + (i + 0.5) * spacing;
    const claimed = (side, d) => existing.some(e => e.side === side && Math.abs(e.at - d) <= spacing / 2);
    const sides = (i % 2 ? [-1, 1] : [1, -1]).filter(side => !claimed(side, d0));
    if (!sides.length) { alreadyTreed++; continue; }
    search: for (let k = 0; k <= reach; k++) {
      for (const d of k ? [d0 + k, d0 - k] : [d0]) {
        if (d < st.a || d > st.b) continue;
        const q = alongXY(st, d);
        for (const side of sides) {
          if (claimed(side, d)) continue;  // sliding along must not walk into an existing tree's stretch
          for (let off = start; off <= Math.max(start, pl.max_offset_m); off += 0.5) {
            const p = {x: q.x - q.ty * side * off, y: q.y + q.tx * side * off};
            const why = blocked(p, r, placed, obstacles);
            if (!why) {
              const where = relate(st, p.x, p.y);  // on bends the point can project onto another stretch or side
              if (claimed(where.side, where.at)) break;
              placed.push(p);
              break search;
            }
            if (why === 'building' || why === 'water') break;
          }
        }
      }
    }
  }
  return {trees: placed.map(p => { const [lon, lat] = P.toLL(p.x, p.y); return {lon, lat}; }), alreadyTreed};
}

// ------------------------------------------------------------------ measures
// One measure at a time (config/model.json "measures"). buildMeasure() turns the controls into
// what the worker needs (in local metres), what the map shows and extra rows for the result.

function setMeasure(kind) {
  S.measure = kind;
  $('measure').value = kind;
  $('measureNote').innerHTML = esc(S.model.measures[kind].note || '') + '&nbsp;' + srcButton(Object.values(SOURCE_IDS[kind] || {}).flat().filter((id, i, a) => a.indexOf(id) === i));
  for (const el of document.querySelectorAll('[data-measure]')) el.hidden = el.dataset.measure !== kind;
  layoutView();
  hint('');
  update();
}

function buildMeasure(P, trees, sun) {
  const st = S.street, kind = S.measure, q = S.model.measures[kind];
  const section = sectionLine(P).geometry.coordinates.map(([lon, lat]) => P.toXY(lon, lat));
  const len = st.b - st.a, poly = (pts, props) => turf.polygon([[...pts, pts[0]].map(p => P.toLL(p.x, p.y))], props);
  const disc = (c, r, props) => poly(Array.from({length: 24}, (_, i) => ({x: c.x + r * Math.cos(i / 24 * 2 * Math.PI), y: c.y + r * Math.sin(i / 24 * 2 * Math.PI)})), props);
  const roadway = props => ({...turf.buffer(sectionLine(P), Math.max(1, st.halfWidth), {units: 'meters'}), properties: props});
  const centre = alongXY(st, (st.a + st.b) / 2), mid = P.toLL(centre.x, centre.y);

  const rect = (c, props) => poly(NG.boxRing(c).map(([x, y]) => ({x, y})), props);

  if (kind === 'trees') return {measure: {kind, trees: trees.map(t => ({...t, ...P.toXY(t.lon, t.lat)}))}, features: [], rows: []};

  if (kind === 'sails') {
    const n = +$('sails').value, span = document.querySelector('input[name=sailSpan]:checked').value;
    const key = [st.a, st.b, n, span].join('|');
    if (S.layout.key !== key) S.layout = {key, sails: placeSails(n, span)};
    const sails = S.layout.sails, area = sails.reduce((sum, c) => sum + c.len * c.w, 0);
    $('sailsLabel').textContent = sails.length === n ? String(n) : `${sails.length} of ${n} fit`;
    return {measure: {kind, sails},
            shadows: sails.map(c => NG.sailShadow(c, sun, S.model)).filter(Boolean).map(c => rect(c, {})),
            features: S.view3d ? [] : sails.map(c => rect(c, {color: '#fff4e6', outline: '#e8590c', opacity: 0.85})),
            solids: sails.map(c => rect(c, {base: c.h, top: c.h + 0.15, color: '#ffe8cc', kind: 'planted'})),  // 3D view
            rows: [['Sail area', `${Math.round(area).toLocaleString('en')} m²`],
                   ...(span === 'across' && st.halfWidth > 2.5 ? [[`Spans the roadway: ${q.across.height_m} m high, anchored on both sides.`, null, 'note']] : [])]};
  }

  if (kind === 'beds') {
    const w = +$('bedWidth').value, share = +$('bedShare').value / 100;
    const key = [st.a, st.b, w, share].join('|');
    if (S.layout.key !== key) S.layout = {key, cells: placeBeds(w, share)};
    const cells = S.layout.cells, area = cells.reduce((sum, c) => sum + c.len * c.w, 0);
    const wanted = 2 * len * share * w;
    $('bedWidthLabel').textContent = `${w} m`;
    $('bedShareLabel').textContent = `${Math.round(share * 100)} %`;
    return {measure: {kind, cells}, features: cells.map(c => rect(c, {color: '#51cf66', outline: '#2b8a3e', opacity: 0.75})),
            rows: [['Beds', `${Math.round(area).toLocaleString('en')} m²`],
                   ...(area < wanted * 0.95 ? [[`Room for beds on ${Math.round((100 * area) / wanted)} % of the strip only.`, null, 'note']] : [])]};
  }

  if (kind === 'pavement') {
    const albedo = +$('albedo').value, dAlbedo = Math.max(0, albedo - q.albedo_before);
    $('albedoLabel').textContent = `${albedo.toFixed(2)} (today ~${q.albedo_before})`;
    return {measure: {kind, line: section, halfWidth: st.halfWidth, dAlbedo},
            features: [roadway({color: '#f1f3f5', outline: '#868e96', opacity: 0.85})],
            rows: [['Coated roadway', `${Math.round(len * 2 * st.halfWidth).toLocaleString('en')} m²`],
                   ['Air in full sun', `${signed(-q.air_C_per_0_1_albedo * dAlbedo / 0.1)} °C`],
                   ['Reflected sun (felt)', `${signed(q.reflected_felt_C_per_0_1_albedo * dAlbedo / 0.1)} °C`]]};
  }

  if (kind === 'misting') {
    const n = +$('poles').value, key = [st.a, st.b, n].join('|');
    if (S.layout.key !== key) S.layout = {key, poles: placeEvenly(n, 0.5, P, false).trees.map(t => P.toXY(t.lon, t.lat))};
    const poles = S.layout.poles, [from, to] = q.operating_hours, h = +$('time').value / 60;
    $('polesLabel').textContent = poles.length === n ? String(n) : `${poles.length} of ${n} fit`;
    return {measure: {kind, poles}, features: poles.flatMap(c => [disc(c, 2 * q.sigma_m, {color: '#4dabf7', outline: '#4dabf7', opacity: 0.25}),
                                                                   disc(c, 0.6, {color: '#1c7ed6', outline: '#1864ab', opacity: 0.95})]),
            rows: [['Water', `~${(poles.length * q.water_l_per_h_per_pole).toLocaleString('en')} l per hour`],
                   ...(h < from || h >= to ? [[`Switched off now, runs ${from}–${to} h.`, null, 'note']] : [])]};
  }

  // traffic: engine heat over the roadway, from assumed vehicles per day and road class
  const limit = q.current_limit_kmh[st.kind] ?? q.current_limit_kmh.default;
  const vehicles = q.vehicles_per_day[st.kind] ?? q.vehicles_per_day.default;
  const to30 = $('speed').value === '30' && limit > 30, volume = +$('volume').value / 100;
  const flux = (vehicles * q.heat_MJ_per_vehicle_km * 1e6) / 86400 / 1000 / Math.max(2, 2 * st.halfWidth);  // W/m² of roadway
  const after = flux * volume * (to30 ? q.fuel_factor_30 : 1);
  const noise = volume ? 10 * Math.log10(volume) + (to30 ? q.noise_30_dB : 0) : null;
  $('volumeLabel').textContent = volume === 1 ? 'unchanged' : volume ? `−${Math.round((1 - volume) * 100)} %` : 'car-free';
  // particulate matter: the part this street's own traffic adds falls with it (README "Traffic and particulate matter")
  const pmShare = (q.pm_traffic_share[S.overlay.pm_size] ?? q.pm_traffic_share.pm10) * Math.min(1, vehicles / q.pm_reference_vehicles_per_day);
  const pmPct = -100 * pmShare * (1 - volume * (to30 ? q.pm_factor_30 : 1));
  const label = [to30 && volume && '30 km/h', volume < 1 && $('volumeLabel').textContent + (volume ? ' cars' : '')].filter(Boolean).join(' · ');
  // on a noise map: car-free is capped at −20 dB (what remains is background noise)
  return {measure: {kind, line: section, halfWidth: st.halfWidth, dFlux: flux - after, dNoise: noise == null ? -20 : noise, pmPct},
          features: [roadway({color: '#fab005', outline: '#e67700', opacity: 0.3}), ...(label ? [turf.point(mid, {label})] : [])],
          rows: [['Engine heat', `${flux.toFixed(1)} → ${after.toFixed(1)} W/m²`, '', ['traffic']],
                 ['Noise', noise == null ? 'none' : `${signed(noise)} dB(A)`, '', ['traffic']],
                 ...(S.overlay.quantity === 'pm' ? [['Particles from this street', `~${Math.round(pmShare * 100)} % (est.)`, '', ['traffic_pm']]] : []),
                 [`Assumed today: ${limit} km/h, ${vehicles.toLocaleString('en')} vehicles a day (from the road class).` +
                  ($('speed').value === '30' && !to30 ? ' The limit is probably 30 km/h or less already.' : ''), null, 'note']]};
}

// Shade sails evenly along the section: over the pavements on alternating sides (the other side
// if a building is in the way), or across the whole street. Overhead, so roads do not block them.
function placeSails(n, span) {
  const st = S.street, pl = S.model.placement, q = S.model.measures.sails, sails = [];
  const spacing = (st.b - st.a) / Math.max(n, 1), buildings = {roads: [], buildings: st.obstacles.buildings, trees: []};
  for (let i = 0; i < n; i++) {
    const c = alongXY(st, st.a + (i + 0.5) * spacing);
    if (span === 'across') {
      const g = q.across;
      sails.push({x: c.x, y: c.y, tx: c.tx, ty: c.ty, len: Math.min(g.length_m, spacing), w: 2 * (st.halfWidth + g.pavement_m), h: g.height_m});
      continue;
    }
    const g = q.pavement, off = (st.halfWidth || pl.path_offset_m) + pl.clearance_m + g.width_m / 2;
    for (const side of i % 2 ? [-1, 1] : [1, -1]) {
      const p = {x: c.x - c.ty * side * off, y: c.y + c.tx * side * off};
      if (blocked(p, 0, [], buildings)) continue;
      sails.push({...p, tx: c.tx, ty: c.ty, len: Math.min(g.length_m, 2 * spacing), w: g.width_m, h: g.height_m});
      break;
    }
  }
  return sails;
}

// Strips of grass and flowers behind both kerbs, cells of sample_m along the section. Like trees,
// a cell blocked by another road (e.g. tram tracks) moves away from the centre line, up to
// placement.max_offset_m but never into a building or water. share < 1 spreads the beds evenly.
function placeBeds(w, share) {
  const st = S.street, pl = S.model.placement, step = S.model.measures.beds.sample_m, cells = [];
  const start = (st.halfWidth || pl.path_offset_m) + pl.clearance_m + 0.1;  // inner edge, just behind the kerb
  const obstacles = {roads: st.obstacles.roads, buildings: st.obstacles.buildings, trees: []};
  const n = Math.max(1, Math.floor((st.b - st.a) / step));
  for (let k = 0; k < n; k++) {
    if (Math.floor((k + 1) * share) === Math.floor(k * share)) continue;
    const q = alongXY(st, st.a + (k + 0.5) * ((st.b - st.a) / n));
    const at = (side, off) => ({x: q.x - q.ty * side * off, y: q.y + q.tx * side * off});
    for (const side of [1, -1]) {
      for (let off = start; off + w <= Math.max(start + w, pl.max_offset_m); off += 0.5) {
        const why = [at(side, off), at(side, off + w / 2), at(side, off + w)].map(c => blocked(c, 0, [], obstacles)).find(Boolean);
        if (!why) { cells.push({...at(side, off + w / 2), tx: q.tx, ty: q.ty, len: (st.b - st.a) / n, w}); break; }
        if (why === 'building' || why === 'water') break;
      }
    }
  }
  return cells;
}

// Existing trees beside the selected street: distance along it and side (+1 left, -1 right),
// for trees up to maxOffset (plus their crown) from the centre line.
function existingAlongStreet(st, maxOffset) {
  const out = [];
  for (const t of st.obstacles.trees) {
    const w = relate(st, t.x, t.y);
    if (Math.abs(w.lateral) <= maxOffset + t.r) out.push(w);
  }
  return out;
}

// Position of (x, y) relative to a measured street: distance along it, signed lateral offset, side.
function relate(st, x, y) {
  const at = locate(st, x, y), q = alongXY(st, at), lateral = (x - q.x) * -q.ty + (y - q.y) * q.tx;
  return {at, lateral, side: Math.sign(lateral) || 1};
}

function toggleManualTree(e) {
  const hit = S.map.queryRenderedFeatures(box(e.point, 6), {layers: ['planted']})[0];
  if (hit) {
    S.manual.splice(hit.properties.i, 1);
    return update();
  }
  const P = NG.projection(...S.cfg.center), {lng, lat} = e.lngLat, p = P.toXY(lng, lat);
  const r = S.model.presets[$('preset').value].crown_diameter_m / 2, d = 30 / 111320;
  const obstacles = collectObstacles([lng - d * 1.6, lat - d, lng + d * 1.6, lat + d], P);
  const why = blocked(p, r, S.manual.map(t => P.toXY(t.lon, t.lat)), obstacles);
  if (why) return hint(`No room here: ${why}.`);
  S.manual.push({lon: lng, lat});
  hint('');
  update();
}

// '' if a crown of radius r fits at p, otherwise the reason.
function blocked(p, r, placed, o) {
  const pl = S.model.placement;
  for (const rd of o.roads) if (NG.distToPolyline(p.x, p.y, rd.pts) < rd.half + pl.clearance_m) return 'roadway';
  for (const b of o.buildings) {
    if (p.x >= b.box[0] && p.x <= b.box[2] && p.y >= b.box[1] && p.y <= b.box[3] && NG.inPolygon(p.x, p.y, b.rings)) return b.kind === 'water' ? 'water' : 'building';
  }
  for (const t of o.trees) if (Math.hypot(p.x - t.x, p.y - t.y) < (t.r + r) * pl.existing_tree_spacing) return 'existing tree';
  for (const q of placed) if (Math.hypot(p.x - q.x, p.y - q.y) < 2 * r * pl.crown_overlap) return 'too close to another new tree';
  return '';
}

// Roads, buildings, water and existing trees inside bbox [w, s, e, n] (padded by 40 m), in local metres.
function collectObstacles([w, s, e, n], P) {
  const pad = 40 / 111320, bb = [w - pad * 1.6, s - pad, e + pad * 1.6, n + pad];
  const near = c => c[0] >= bb[0] && c[0] <= bb[2] && c[1] >= bb[1] && c[1] <= bb[3];
  const overlaps = cs => {  // bbox test, so long segments and large polygons count even without a vertex nearby
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of cs) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
    return w <= bb[2] && e >= bb[0] && s <= bb[3] && n >= bb[1];
  };
  const toXY = c => P.toXY(c[0], c[1]);
  const roads = [], buildings = [];
  for (const f of S.map.querySourceFeatures(S.roadSource, {sourceLayer: 'roads'})) {
    const half = roadHalfWidth(f.properties);
    if (!half) continue;
    const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
    for (const part of parts) if (overlaps(part)) roads.push({half, pts: part.map(toXY)});
  }
  for (const layer of ['buildings', 'water']) {
    if (!S.model.placement[`avoid_${layer}`]) continue;
    for (const f of S.map.querySourceFeatures(S.roadSource, {sourceLayer: layer})) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
      for (const poly of polys) {
        if (!overlaps(poly[0])) continue;
        const rings = poly.map(ring => ring.map(toXY)), xs = rings[0].map(q => q.x), ys = rings[0].map(q => q.y);
        buildings.push({kind: layer, rings, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]});
      }
    }
  }
  // existing trees may finish loading later, so read them lazily
  return {roads, buildings, get trees() { return S.existingTrees.filter(t => near([t.lon, t.lat])).map(t => ({...toXY([t.lon, t.lat]), r: t.r})); }};
}

function roadHalfWidth(props) {
  const t = S.model.placement.road_half_width_m;
  return t[props.kind_detail] ?? t[props.kind] ?? 0;
}

// ------------------------------------------------------------------ data layers (trees, bike data, ...)
// Entries of config/overlays.json "layers": without "group" -> checkbox, same "group" -> one select.

function setupDataLayers() {
  const groups = new Map();
  for (const l of S.cfg.layers || []) {
    if (l.obstacle) {
      layerData(l).then(d => {
        S.existingTrees = d.features.filter(f => f.geometry?.type === 'Point').map(f => ({
          lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
          r: (num(f.properties[l.crownDiameterField]) || S.model.placement.default_existing_crown_m) / 2}));
        update();
      }).catch(() => {});
    }
    if (l.group) { (groups.get(l.group) || groups.set(l.group, []).get(l.group)).push(l); continue; }
    const row = document.createElement('label');
    row.className = 'check';
    row.innerHTML = `<input type="checkbox"> ${l.label}`;
    const cb = row.firstChild;
    cb.checked = !!l.visible;
    cb.onchange = () => showLayer(l, cb.checked);
    $('layers').append(row, legendFor(l));
    if (l.visible) showLayer(l, true);
  }
  // Grouped layers (the "Environment data" dropdown) are switched off for the demo; uncomment to bring them back.
  // for (const [group, list] of groups) {
  //   const label = document.createElement('label');
  //   label.textContent = group;
  //   const sel = document.createElement('select');
  //   sel.add(new Option('– off –', ''));
  //   for (const l of list) sel.add(new Option(l.label, l.id));
  //   sel.onchange = () => list.forEach(l => showLayer(l, l.id === sel.value));
  //   $('layers').append(label, sel, ...list.map(legendFor));
  // }
}

async function showLayer(l, on) {
  if (l.type === 'table') return showTable(l, on);
  const id = `lyr-${l.id}`;
  $(`legend-${l.id}`).hidden = !on || !l.value;
  if (!on) { if (S.map.getLayer(id)) S.map.setLayoutProperty(id, 'visibility', 'none'); return; }
  if (!S.map.getLayer(id)) {
    let data;
    try {
      setStatus(`Loading ${l.label} …`);
      data = await layerData(l);
      setStatus(`${l.label}: ${data.features.length.toLocaleString('en')} features`);
    } catch (e) {
      return setStatus(`“${l.label}” is not available: ${e.message}`, true);
    }
    if (S.map.getLayer(id)) return;  // toggled twice while loading
    S.map.addSource(id, {type: 'geojson', data});
    S.map.addLayer({...layerStyle(l, id), ...(l.minzoom ? {minzoom: l.minzoom} : {})}, 'section');
    S.map.on('mousemove', id, e => tooltip(l, e));
    S.map.on('mouseleave', id, () => S.popup.remove());
  }
  S.map.setLayoutProperty(id, 'visibility', 'visible');
  if (l.fitOnShow) {  // data far outside the current view, e.g. regional sites
    S.map.fitBounds(turf.bbox(await layerData(l)), {padding: {top: 80, bottom: 80, left: 330, right: 80}, maxZoom: 14, duration: 800});
  }
}

// City-wide figures without locations: outline the city and show the table in the panel.
async function showTable(l, on) {
  const box = $(`legend-${l.id}`);
  box.hidden = !on;
  if (!S.map.getSource('city-outline') && S.cfg.cityBoundary) {
    S.map.addSource('city-outline', {type: 'geojson', data: S.cfg.cityBoundary});
    S.map.addLayer({id: 'city-outline', type: 'line', source: 'city-outline',
                    paint: {'line-color': '#1c7ed6', 'line-width': 2.5, 'line-dasharray': [3, 2]}}, 'section');
  }
  const anyTable = (S.cfg.layers || []).some(x => x.type === 'table' && $(`legend-${x.id}`)?.hidden === false);
  if (S.map.getLayer('city-outline')) S.map.setLayoutProperty('city-outline', 'visibility', anyTable ? 'visible' : 'none');
  if (!on || box.dataset.loaded) return;
  try {
    const t = await layerData(l);
    const cell = v => `<td>${typeof v === 'number' ? v.toLocaleString('en') : v ?? ''}</td>`;
    box.innerHTML = `<p class="muted"><strong>${t.title}</strong></p><div class="table-wrap"><table class="data-table">
      <thead><tr>${t.columns.map(c => `<th>${c}</th>`).join('')}</tr></thead>
      <tbody>${t.rows.map(r => `<tr>${r.map(cell).join('')}</tr>`).join('')}</tbody></table></div>
      ${t.note ? `<p class="muted">${t.note}</p>` : ''}`;
    box.dataset.loaded = '1';
  } catch (e) {
    setStatus(`“${l.label}” is not available: ${e.message}`, true);
  }
}

function layerData(l) {
  return S.layerData[l.id] ??= fetch(l.url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .catch(e => { delete S.layerData[l.id]; throw e; });
}

function layerStyle(l, id) {
  const value = ['to-number', ['get', l.value], NaN];
  const ramp = l.ramp || RAMP, [d0, d1] = l.domain || [0, 1];
  const color = !l.value ? l.color || '#2b8a3e' : ['case', ['==', value, value],
    ['interpolate', ['linear'], value, ...ramp.flatMap((c, i) => [d0 + ((d1 - d0) * i) / (ramp.length - 1), c])], '#adb5bd'];
  if (l.type === 'line') {
    return {id, type: 'line', source: id, layout: {'line-cap': 'round', 'line-join': 'round'},
            paint: {'line-color': color, 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 18, 6]}};
  }
  const crown = !!l.crownDiameterField;
  if (crown && S.icons[`lyr-${l.id}`]) {
    const diameter = ['to-number', ['get', l.crownDiameterField], S.model.placement.default_existing_crown_m];
    return iconLayer(id, id, diameter, 10, 0.85, `lyr-${l.id}`);
  }
  const radius = crown
    ? metres(['/', ['to-number', ['get', l.crownDiameterField], S.model.placement.default_existing_crown_m], 2], 1.5)
    : ['interpolate', ['linear'], ['zoom'], 12, (l.radius || [2, 7])[0], 18, (l.radius || [2, 7])[1]];
  return {id, type: 'circle', source: id, paint: {'circle-color': color, 'circle-radius': radius,
          'circle-opacity': crown ? 0.45 : 0.85, 'circle-stroke-color': crown ? '#1b5e20' : '#fff', 'circle-stroke-width': crown ? 0.6 : 0.8}};
}

function legendFor(l) {
  const div = document.createElement('div');
  div.id = `legend-${l.id}`;
  div.hidden = true;
  if (!l.value) return div;
  const [d0, d1] = l.domain || [0, 1];
  div.innerHTML = `<div class="ramp" style="background:linear-gradient(90deg,${(l.ramp || RAMP).join(',')})"></div>
    <div class="ticks"><span>${d0}</span><span>${l.unit || ''}</span><span>${d1}</span></div>`;
  return div;
}

function tooltip(l, e) {
  const p = e.features[0].properties;
  const rows = Object.entries(l.tooltip || {}).filter(([k]) => p[k] != null && p[k] !== '' && p[k] !== 'None')
    .map(([k, label]) => `<dt>${label}</dt><dd>${pretty(p[k])}</dd>`).join('');
  S.popup.setLngLat(e.lngLat).setHTML(`<strong>${l.label}</strong><dl>${rows}</dl>`).addTo(S.map);
}

function pretty(v) {
  if (typeof v === 'number' || /^\s*-?\d+(\.\d+)?\s*$/.test(v)) {
    const n = +v;
    if (Math.abs(n) < 10000) return String(Math.abs(n) >= 100 ? Math.round(n) : +n.toFixed(2));  // years, small counts: no separator
    return Math.round(n).toLocaleString('en');
  }
  return String(v).replace(/^\[|\]$/g, '').replace(/'/g, '');  // "['A', 'B']" -> "A, B"
}

// ------------------------------------------------------------------ heat overlay data

async function loadOverlay(o, {refresh = false} = {}) {
  if (!refresh) setStatus('Loading data …');
  let records;
  try {
    records = await loadRecords(o);
    if (!records.length) throw new Error('no measurements');
  } catch (e) {
    setStatus(`“${o.label}” is not available: ${e.message}`, true);
    if (S.overlay) $('overlay').value = S.overlay.id;
    return;
  }
  Object.assign(S, {overlay: o, records, hasTime: records.some(r => r.t != null)});
  $('overlay').value = o.id;
  const vals = records.map(r => r.v).sort((a, b) => a - b);
  S.domain = o.domain || [quantile(vals, 0.02), quantile(vals, 0.98)];
  const pad = 0.005, lons = records.map(r => r.lon), lats = records.map(r => r.lat);
  S.extent = [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad];
  if (!refresh && records[0].date) $('date').value = records[0].date;

  S.ramp = o.ramp || RAMP;
  $('ramp').style.background = `linear-gradient(90deg, ${S.ramp.join(',')})`;
  $('dmin').textContent = S.domain[0].toFixed(0);
  $('dmax').textContent = S.domain[1].toFixed(0);
  $('unit').textContent = o.unit || '';
  setStatus(`${records.length.toLocaleString('en')} measurements` +
            (o.refreshSeconds ? ` · updated ${new Date().toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'})}` : ''));

  clearInterval(S.refresh);
  if (o.refreshSeconds) S.refresh = setInterval(() => loadOverlay(o, {refresh: true}), o.refreshSeconds * 1000);
  update();
}

// Any CSV / JSON array / GeoJSON with a numeric value field becomes [{lon, lat, v, t, date}].
async function loadRecords(o) {
  const res = await fetch(o.url, {cache: 'no-store'});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let rows, lonKey = o.lon || 'lon', latKey = o.lat || 'lat';
  if (o.format === 'csv') {
    rows = parseCsv(await res.text());
  } else {
    const json = await res.json();
    if (o.format === 'geojson') {
      rows = json.features.filter(f => f.geometry).map(f => {
        const [lon, lat] = f.geometry.type === 'Point' ? f.geometry.coordinates : turf.centroid(f).geometry.coordinates;
        return {...f.properties, _lon: lon, _lat: lat};
      });
      [lonKey, latKey] = ['_lon', '_lat'];
    } else {
      rows = Array.isArray(json) ? json : json[o.path || 'data'];
    }
  }
  return rows.map(r => ({lon: num(r[lonKey]), lat: num(r[latKey]), v: num(r[o.value]), ...parseTime(r[o.time])}))
             .filter(r => Number.isFinite(r.lon) && Number.isFinite(r.lat) && Number.isFinite(r.v));
}

// Time series: per location, the value closest to the chosen time of day.
function currentPoints() {
  if (!S.hasTime) return S.records.map(({lon, lat, v}) => ({lon, lat, v}));
  const minute = +$('time').value, maxGap = S.overlay.maxTimeGapMinutes ?? 30, best = new Map();
  for (const r of S.records) {
    const d = r.t == null ? Infinity : Math.abs(r.t - minute);
    if (d > maxGap) continue;
    const k = `${r.lon.toFixed(5)},${r.lat.toFixed(5)}`, b = best.get(k);
    if (!b || d < b.d) best.set(k, {lon: r.lon, lat: r.lat, v: r.v, d});
  }
  return [...best.values()];
}

// ------------------------------------------------------------------ update loop

function update() {
  clearTimeout(S.timer);
  S.timer = setTimeout(run, 30);
}

function run() {
  if (!S.overlay) return;
  const minute = +$('time').value;
  $('timeLabel').textContent = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const sun = sunPosition();
  const alt = sun.altitude / NG.DEG, bearing = (sun.azimuth / NG.DEG + 180 + 360) % 360;
  $('sun').textContent = alt > 0 ? `Sun: ${alt.toFixed(0)}° high, from the ${compass(bearing)} (${bearing.toFixed(0)}°)` : 'Sun below the horizon';

  let scenario = null;
  if (S.street) {
    const P = NG.projection(...S.cfg.center), section = sectionLine(P);
    const trees = S.measure === 'trees' ? currentTrees(P) : [], built = buildMeasure(P, trees, sun);
    const shadows = trees.map(t => NG.shadowEllipse({...t, ...P.toXY(t.lon, t.lat)}, sun, S.model)).filter(Boolean)
      .map(e => { const ring = NG.ellipseRing(e).map(([x, y]) => P.toLL(x, y)); return turf.polygon([[...ring, ring[0]]]); });
    setData('section', fc([section]));
    setData('planted', fc(trees.map((t, i) => turf.point([t.lon, t.lat], {r: t.crown_diameter_m / 2, i}))));
    setData('shadows', fc([...shadows, ...(built.shadows || [])]));
    setData('measure', fc(built.features));
    S.resultRows = built.rows;
    if (S.view3d) {
      const models = S.deck && iconThemes()[S.iconTheme]?.models3d;
      setData('trees-3d', fc([...(models ? [] : trees3D(trees, P)), ...(built.solids || [])]));  // block trees only as fallback
      if (models) S.deck.setProps({layers: treeModelLayers(trees, P, models)});
    }
    const len = Math.round(S.street.b - S.street.a), n = +$('trees').value;
    $('secLabel').textContent = `Section: ${len} m` + (S.street.b - S.street.a < S.street.length - 1 ? ` of ${Math.round(S.street.length)} m` : '');
    const treed = S.mode === 'even' ? S.placement.alreadyTreed || 0 : 0;
    $('treeLabel').textContent = !n ? 'none'
      : trees.length === n ? `${n} · every ${Math.round(len / n)} m`
      : `${trees.length} of ${n}` + (treed ? ` · ${treed} spot${treed > 1 ? 's' : ''} already treed` : ' fit');
    $('manualCount').textContent = `${S.manual.length} ${S.manual.length === 1 ? 'tree' : 'trees'} placed`;
    scenario = {measure: built.measure, section: section.geometry.coordinates, sun, minute,
                quantity: S.overlay.quantity || 'temperature', canyonShare: canyonShare()};
  } else {
    for (const id of ['section', 'measure', 'planted', 'shadows']) setData(id, fc([]));
  }

  const points = currentPoints();
  if (!points.length) setStatus('No measurements at this time of day.', true);
  const b = S.map.getBounds(), padX = (b.getEast() - b.getWest()) * 0.25, padY = (b.getNorth() - b.getSouth()) * 0.25;
  let view = [b.getWest() - padX, b.getSouth() - padY, b.getEast() + padX, b.getNorth() + padY];
  if (S.view3d && S.street) {  // a tilted view reaches to the horizon: rasterise only around the street
    const [w, s, e, n] = turf.bbox(sectionLine(NG.projection(...S.cfg.center))), d = VIEW3D.radius_m / 111320;
    view = [w - d * 1.6, s - d, e + d * 1.6, n + d];
  }
  const canvas = S.map.getCanvas(), W = Math.min(900, Math.round(canvas.clientWidth * 0.75));
  const H = Math.max(1, Math.round((W * canvas.clientHeight) / canvas.clientWidth));
  if (!worker) return;
  worker.postMessage({id: ++S.job, points, origin: S.cfg.center, extent: S.extent, view, size: [W, H],
                      domain: S.domain, ramp: S.ramp || RAMP, params: S.model, scenario, interpolation: S.overlay.interpolation});
}

function onWorkerResult({data}) {
  if (data.id !== S.job) return;  // a newer request is already on its way
  if (data.image) {
    const old = S.url;
    S.url = URL.createObjectURL(data.image.blob);
    S.map.getSource('heat').updateImage({url: S.url, coordinates: data.image.coordinates});
    if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
  }
  S.map.setLayoutProperty('heat', 'visibility', data.image ? 'visible' : 'none');
  showResult(data.stats);
}

// ------------------------------------------------------------------ model sections
// Two collapsible sections in the scenario panel. Empirical: the map model (felt temperature from
// shade plus evaporation, values from studies) on the selected street. Physics-inspired: the canyon
// box model of street_tree_cooling_model.ipynb (air temperature of a generic street, trees only).
// Each header shows its headline number, so both can be compared while collapsed.

const canyonAvailable = () => !!S.canyon && S.measure === 'trees';

function layoutView() {
  $('canyonBox').hidden = !canyonAvailable();
  renderSummaries();
}

function renderSummaries() {
  const st = S.lastStats, sc = S.canyon?.scenarios.find(s => s.id === S.canyonId);
  const quantity = S.overlay?.quantity || 'temperature', unit = quantity === 'temperature' ? '°C' : S.overlay?.unit || '';
  const show = (el, v, digits, u) => { el.textContent = v == null ? '' : `${signed(v, digits)} ${u}`; el.classList.toggle('warm', v > 0); };
  show($('sumEmpirical'), st ? st.after - st.before : null, 1, unit);
  show($('sumCanyon'), sc?.outputs.dT_total, 2, '°C');
}

function showResult(st) {
  if (!S.street) return;
  const unit = S.overlay.unit || '', quantity = S.overlay.quantity || 'temperature';
  if (st && (st.quantity || 'temperature') !== quantity) return;  // computed for other data; the right one follows
  S.lastStats = st;
  layoutView();
  const trees = S.measure === 'trees', label = S.model.measures[S.measure].label;
  const m2 = v => Math.round(v).toLocaleString('en');
  const src = SOURCE_IDS[S.measure]?.[quantity];  // ⓘ next to the change: the parts behind this result
  let rows, note = '';
  if (!st) {
    rows = [['No values along the street', '']];
  } else {
    rows = [
      ['Mean before', `${st.before.toFixed(1)} ${unit}`],
      [`Mean with ${trees ? 'trees' : 'measure'}`, `${st.after.toFixed(1)} ${unit}`],
      ['Change', `${signed(st.after - st.before)} ${quantity === 'temperature' ? '°C' : unit}` +
                 (quantity === 'pm' && st.pct != null ? ` (${signed(st.pct)} %)` : ''), 'big', src],
    ];
    if (quantity === 'pm' && trees) {
      const share = S.canyonShare?.share ?? 0;
      rows.push(['Street type', share >= 0.5 ? `street canyon (${Math.round(share * 100)} % of the section)`
                                             : `open street (canyon: ${Math.round(share * 100)} %)`],
                ['Crown cover', `${Math.round(st.coverage * 100)} % of the street`]);
      note = 'In street canyons, tree crowns slow the air exchange and raise particle levels; on open streets they remove a little by deposition.';
    } else if (quantity === 'noise' && trees) {
      note = 'Rows of street trees hardly reduce traffic noise. Measurable reductions need dense tree belts about 15–20 m deep.';
    } else if (quantity === 'pm' && S.measure === 'traffic') {
      note = 'Rough estimate from the difference between Heilbronn\'s traffic and background stations. Most traffic particles come from brakes, tyres and road dust, so fewer vehicles help, a lower speed limit hardly.';
    } else if (quantity !== 'temperature' && S.measure !== 'traffic') {
      note = `${label}: no effect on ${quantity === 'pm' ? 'particulate matter' : 'noise'} in this model.`;
    } else if (quantity === 'temperature') {
      rows.push(['Strongest cooling', `${signed(st.maxCooling)} °C`, '', trees ? ['shade'] : src],
                ...(st.maxWarming > 0.05 ? [['Strongest warming', `${signed(st.maxWarming)} °C`]] : []),
                ...(trees || S.measure === 'sails' ? [['Shaded', `${m2(st.shadedArea)} of ${m2(st.area)} m²`, '', [trees ? 'shade' : 'sails', 'sun']]] : []));
    }
  }
  rows.push(...(S.resultRows || []));
  $('result').innerHTML = rows.map(([k, v, cls, ids]) => cls === 'note' ? `<dt class="muted" style="grid-column:1/-1">${k}</dt>`
                                                         : `<dt>${k}${ids ? '&nbsp;' + srcButton(ids) : ''}</dt><dd class="${cls || ''}">${v}</dd>`).join('') +
    `<dt class="muted" style="grid-column:1/-1">Mean within ${S.model.street_corridor_m} m on both sides of the section</dt>` +
    (note ? `<dt class="muted" style="grid-column:1/-1">${note}</dt>` : '');
}

// Share of the section with buildings close on both sides (a street canyon), cached per section.
function canyonShare() {
  const st = S.street, hw = S.model.pollution?.canyon_max_halfwidth_m ?? 15, key = `${st.name}|${st.a}|${st.b}`;
  if (S.canyonShare?.key === key) return S.canyonShare.share;
  const inBuilding = (x, y) => st.obstacles.buildings.some(b => b.kind !== 'water'
    && x >= b.box[0] && x <= b.box[2] && y >= b.box[1] && y <= b.box[3] && NG.inPolygon(x, y, b.rings));
  let n = 0, both = 0;
  for (let d = st.a; d <= st.b; d += 5) {
    const q = alongXY(st, d), side = s => {
      for (let off = 2; off <= hw; off += 1) if (inBuilding(q.x - q.ty * s * off, q.y + q.tx * s * off)) return true;
      return false;
    };
    n++;
    if (side(1) && side(-1)) both++;
  }
  S.canyonShare = {key, share: n ? both / n : 0};
  return S.canyonShare.share;
}

// ------------------------------------------------------------------ 3D street view (prototype)
// Tilts the camera down into the selected street. Buildings are extruded from the basemap
// (real height where known), trees become a trunk plus a crown of their real size.

const VIEW3D = {pitch: 85, eye_height_m: 1.8, radius_m: 300, default_building_m: 10};
const TREE_COLOURS = {  // per tree icon style: [planted crown, existing crown], tiers = stepped fir
  normal: {planted: '#37b24d', existing: '#82c91e'},
  halloween: {planted: '#f76707', existing: '#845ef7'},
  christmas: {planted: '#2b8a3e', existing: '#5c940d', tiers: true},
};

function set3D(on) {
  if (on === S.view3d || (on && !S.street)) return;
  S.view3d = on;
  $('view3d').textContent = on ? 'Back to top-down map' : '3D street view';
  $('view3d').classList.toggle('active', on);
  const flat = ['planted', 'lyr-trees', 'hotspots', 'hotspot-labels', 'section'];  // flat 2D marks, a broad band at eye level
  if (on) {
    S.hiddenFor3D = flat.filter(id => S.map.getLayer(id) && S.map.getLayoutProperty(id, 'visibility') !== 'none');
    S.hiddenFor3D.forEach(id => S.map.setLayoutProperty(id, 'visibility', 'none'));
    S.map.setMaxPitch(85);
    add3DLayers();
    ensureDeck().then(ok => { if (ok && S.view3d) update(); });
    S.map.easeTo({...eyeLevelCamera(), duration: 1600});
  } else {
    (S.hiddenFor3D || []).forEach(id => S.map.getLayer(id) && S.map.setLayoutProperty(id, 'visibility', 'visible'));
    for (const id of ['buildings-3d', 'trees-3d-existing', 'trees-3d-planted']) if (S.map.getLayer(id)) S.map.removeLayer(id);
    S.deck?.setProps({layers: []});
    S.map.easeTo({pitch: 0, bearing: 0, zoom: Math.min(S.map.getZoom(), 17.5), duration: 1200});
    S.map.once('moveend', () => { if (!S.view3d) S.map.setMaxPitch(60); });
  }
  update();
}

// Camera standing at the start of the section at eye height, looking along it. MapLibre places
// the camera from zoom and pitch, so solve the zoom for the wanted height above the street:
//   height = cameraToCenterDistance · metresPerPixel(zoom) · cos(pitch)
function eyeLevelCamera() {
  const st = S.street, P = NG.projection(...S.cfg.center), eye = alongXY(st, Math.min(st.b, st.a + 3));
  const [eyeLon, eyeLat] = P.toLL(eye.x, eye.y), pitch = VIEW3D.pitch * NG.DEG;
  const toCentre = S.map.transform.cameraToCenterDistance;  // in CSS pixels, fixed by viewport and field of view
  const mppAtZ0 = 78271.517 * Math.cos(eyeLat * NG.DEG);       // metres per pixel at zoom 0 (512 px tiles)
  const zoom = Math.min(S.map.getMaxZoom(), Math.log2((mppAtZ0 * toCentre * Math.cos(pitch)) / VIEW3D.eye_height_m));
  const ahead = toCentre * (mppAtZ0 / 2 ** zoom) * Math.sin(pitch);  // the camera looks at a point this far ahead
  const [lon, lat] = P.toLL(eye.x + eye.tx * ahead, eye.y + eye.ty * ahead);
  return {center: [lon, lat], zoom, pitch: VIEW3D.pitch, bearing: Math.atan2(eye.tx, eye.ty) / NG.DEG};
}

function add3DLayers() {
  const m = S.map, {firstLabel} = anchors(m.getStyle().layers);
  if (!m.getSource('trees-3d')) m.addSource('trees-3d', {type: 'geojson', data: fc([])});
  if (!m.getLayer('buildings-3d')) {
    m.addLayer({id: 'buildings-3d', type: 'fill-extrusion', source: S.roadSource, 'source-layer': 'buildings', minzoom: 14,
                paint: {...THEME_PAINT[S.theme]['buildings-3d'], 'fill-extrusion-opacity': 0.92,
                        'fill-extrusion-height': ['coalesce', ['get', 'height'], VIEW3D.default_building_m],
                        'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0]}}, firstLabel);
  }
  for (const [id, kind, opacity] of [['trees-3d-existing', 'existing', 0.85], ['trees-3d-planted', 'planted', 1]]) {
    if (m.getLayer(id)) continue;
    m.addLayer({id, type: 'fill-extrusion', source: 'trees-3d', filter: ['==', ['get', 'kind'], kind],
                paint: {'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-opacity': opacity,
                        'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'top']}}, firstLabel);
  }
}

// 3D models (glTF) via deck.gl, loaded on first use. Each tree style lists its models in
// config/overlays.json (iconThemes.<style>.models3d); without them the block trees stay.
const DECK_JS = ['https://unpkg.com/deck.gl@9.3.11/dist.min.js', 'https://unpkg.com/@loaders.gl/gltf@4.4.5/dist/dist.min.js'];

function loadScript(src) {
  return new Promise((ok, fail) => {
    const el = document.createElement('script');
    el.src = src; el.onload = ok; el.onerror = () => fail(new Error(`could not load ${src}`));
    document.head.append(el);
  });
}

async function ensureDeck() {
  if (S.deck) return true;
  try {
    S.deckLoading ??= DECK_JS.reduce((p, src) => p.then(() => loadScript(src)), Promise.resolve());
    await S.deckLoading;
    // deck.gl 9.3 reads the camera's near/far planes from transform._nearZ/_farZ, which MapLibre 4 calls
    // nearZ/farZ. Without them deck.gl uses its own planes, its depth values no longer match MapLibre's and
    // trees behind buildings show through. Alias the old names (on the prototype, so clones have them too).
    const proto = Object.getPrototypeOf(S.map.transform);
    for (const k of ['nearZ', 'farZ']) {
      if (!(`_${k}` in proto)) Object.defineProperty(proto, `_${k}`, {get() { return this[k]; }, configurable: true});
    }
    S.deck = new deck.MapboxOverlay({interleaved: true, layers: []});  // shares the depth buffer: buildings hide trees
    S.map.addControl(S.deck);
    return true;
  } catch (e) {
    console.warn('3D models unavailable, using block trees', e);
    setStatus('3D models could not be loaded, showing simple trees.', true);
    return false;
  }
}

function treeModelLayers(planted, P, models) {
  const st = S.street, mid = alongXY(st, (st.a + st.b) / 2), reach = VIEW3D.radius_m;
  const yaw = (lon, lat) => ((Math.sin(lon * 12.9898 + lat * 78.233) * 43758.5453) % 1 + 1) % 1 * 360;  // stable per tree
  const place = (m, lon, lat, height, crown) => ({position: [lon, lat, 0], yaw: yaw(lon, lat),
    scale: [crown / Math.max(m.size[0], m.size[2]), height / m.size[1], crown / Math.max(m.size[0], m.size[2])]});
  const existing = [];
  for (const t of S.existingTrees) {
    const {x, y} = P.toXY(t.lon, t.lat);
    if (Math.abs(x - mid.x) > reach || Math.abs(y - mid.y) > reach) continue;
    const crown = 2 * t.r;
    existing.push(place(models.existing || models.planted, t.lon, t.lat, Math.min(25, Math.max(4, crown * 1.4 + 2)), crown));
  }
  const sets = [['planted', models.planted, planted.map(t => place(models.planted, t.lon, t.lat, t.height_m, t.crown_diameter_m))],
                ['existing', models.existing || models.planted, existing]];
  if (models.decoration) {  // e.g. a pumpkin at the foot of every new tree
    const d = models.decoration, k = d.height_m / d.size[1];
    sets.push(['decoration', d, planted.map(t => {
      const {x, y} = P.toXY(t.lon, t.lat), [lon, lat] = P.toLL(x + d.offset_m, y);
      return {position: [lon, lat, 0], yaw: yaw(lat, lon), scale: [k, k, k]};
    })]);
  }
  return sets.filter(([, m]) => m).map(([kind, m, data]) => new deck.ScenegraphLayer({
    id: `model-${kind}`, data, scenegraph: m.url, loaders: [loaders.GLTFLoader],
    getPosition: d => d.position, getOrientation: d => [0, d.yaw, 90], getScale: d => d.scale,
    sizeScale: 1, _lighting: 'pbr', updateTriggers: {getScale: data.length}}));
}

// Trunk and crown of every planted tree and of existing trees near the street, as extrusions.
function trees3D(planted, P) {
  const colours = TREE_COLOURS[S.iconTheme] || TREE_COLOURS.normal, out = [];
  const disc = (x, y, r, n) => Array.from({length: n + 1}, (_, i) => {
    const t = ((i % n) / n) * 2 * Math.PI;
    return P.toLL(x + r * Math.cos(t), y + r * Math.sin(t));
  });
  const piece = (x, y, r, base, top, color, kind, n = 14) =>
    out.push({type: 'Feature', properties: {base, top, color, kind}, geometry: {type: 'Polygon', coordinates: [disc(x, y, r, n)]}});
  const tree = (x, y, height, crown, kind) => {
    const r = crown / 2, crownBase = Math.max(1.5, height - crown), color = colours[kind];
    piece(x, y, Math.max(0.2, crown * 0.04), 0, crownBase + 0.5, '#6b4f36', kind, 6);
    if (colours.tiers) {  // stepped fir: three tiers getting narrower
      const step = (height - crownBase) / 3;
      for (let i = 0; i < 3; i++) piece(x, y, r * (1 - i * 0.3), crownBase + i * step, crownBase + (i + 1) * step, color, kind);
    } else {  // round crown: slices following a sphere's profile
      const slices = 5, sliceH = (height - crownBase) / slices;
      for (let i = 0; i < slices; i++) {
        const z = ((i + 0.5) / slices) * 2 - 1;  // -1 (bottom) .. 1 (top)
        piece(x, y, r * Math.sqrt(1 - z * z * 0.85), crownBase + i * sliceH, crownBase + (i + 1) * sliceH, color, kind);
      }
    }
  };
  for (const t of planted) {
    const {x, y} = P.toXY(t.lon, t.lat);
    tree(x, y, t.height_m, t.crown_diameter_m, 'planted');
  }
  const st = S.street, mid = alongXY(st, (st.a + st.b) / 2), reach = VIEW3D.radius_m;
  for (const t of S.existingTrees) {
    const {x, y} = P.toXY(t.lon, t.lat);
    if (Math.abs(x - mid.x) > reach || Math.abs(y - mid.y) > reach) continue;
    const crown = 2 * t.r;
    tree(x, y, Math.min(25, Math.max(4, crown * 1.4 + 2)), crown, 'existing');  // no heights in the inventory: estimate
  }
  return out;
}

// ------------------------------------------------------------------ helpers

function sunPosition() {
  const [lon, lat] = S.cfg.center;
  const p = SunCalc.getPosition(zonedDate($('date').value, +$('time').value, S.cfg.timezone), lat, lon);
  return {altitude: p.altitude, azimuth: p.azimuth};
}

// Local wall-clock time in `tz` -> Date (UTC instant), DST-safe.
function zonedDate(day, minutes, tz) {
  const [y, m, d] = day.split('-').map(Number), wall = Date.UTC(y, m - 1, d, 0, minutes);
  const offset = ms => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'}).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
  };
  return new Date(wall - offset(wall - offset(wall)));
}

// "2025-07-02 15:10:00" is taken as local time; ISO strings with Z/offset are converted to the configured zone.
function parseTime(s) {
  if (s == null || s === '') return {t: null};
  s = String(s);
  if (/(Z|[+-]\d\d:?\d\d)$/.test(s)) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone: S.cfg.timezone, hourCycle: 'h23', year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}).formatToParts(new Date(s)).map(x => [x.type, x.value]));
    return {date: `${p.year}-${p.month}-${p.day}`, t: +p.hour * 60 + +p.minute};
  }
  const m = /^(\d{4}-\d\d-\d\d)[T ](\d\d):(\d\d)/.exec(s);
  return m ? {date: m[1], t: +m[2] * 60 + +m[3]} : {t: null};
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const split = l => l.split(new RegExp(`${sep}(?=(?:[^"]*"[^"]*")*[^"]*$)`)).map(c => c.replace(/^"|"$/g, ''));
  const head = split(lines[0]);
  return lines.slice(1).map(l => Object.fromEntries(split(l).map((c, i) => [head[i], c])));
}

// ------------------------------------------------------------------ tree icons
// config/overlays.json "iconThemes": named sets of tree icons ('planted' for new trees, otherwise a
// layer id). An icon is ICON_PX square; its central disc of ICON_DISC_PX is drawn at crown size.
// Switching a set swaps the images in place, so layers, data and selection stay as they are.

const ICON_PX = 128, ICON_DISC_PX = 120, ICON_RATIO = 2;

function iconThemes() {
  const t = S.cfg.iconThemes || {};
  return Object.fromEntries(Object.entries(t).filter(([k, v]) => !k.startsWith('_') && typeof v === 'object'));
}

function initialIconTheme() {
  const themes = iconThemes();
  try { const saved = localStorage.getItem('iconTheme'); if (themes[saved]) return saved; } catch {}
  const def = S.cfg.iconThemes?.default;
  if (def && def !== 'auto' && themes[def]) return def;
  const month = new Date().getMonth();  // 9 = October, 11 = December
  const seasonal = month === 9 ? 'halloween' : month === 11 ? 'christmas' : 'normal';
  return themes[seasonal] ? seasonal : Object.keys(themes)[0];
}

async function setIconTheme(name) {
  const theme = iconThemes()[name];
  if (!theme) return;
  S.iconTheme = name;
  try { localStorage.setItem('iconTheme', name); } catch {}
  S.seasonControl?.update();
  await Promise.all(Object.entries(theme).filter(([k, v]) => k !== 'label' && k !== 'symbol' && typeof v === 'string').map(async ([key, url]) => {
    const id = key === 'planted' ? 'planted' : `lyr-${key}`;
    try {
      const img = new Image(ICON_PX, ICON_PX);
      img.src = url;
      await img.decode();
      S.icons[id] = img;
      if (S.map.hasImage(id)) S.map.updateImage(id, img);
      else S.map.addImage(id, img, {pixelRatio: ICON_RATIO});
    } catch (e) {
      console.warn(`icon ${url} not loaded`, e);
    }
  }));
  S.map.triggerRepaint();  // updated images only reach the icon atlas on the next frame
  if (S.view3d) update();  // 3D trees take their colours from the icon style
}

async function loadIcons() {
  // a basemap swap (dark mode) drops all images; put ours back when a layer asks for them
  S.map.on('styleimagemissing', e => { if (S.icons[e.id] && !S.map.hasImage(e.id)) S.map.addImage(e.id, S.icons[e.id], {pixelRatio: ICON_RATIO}); });
  if (Object.keys(iconThemes()).length) await setIconTheme(initialIconTheme());
}

class SeasonControl {
  onAdd() {
    const div = document.createElement('div');
    div.className = 'maplibregl-ctrl maplibregl-ctrl-group season-switch';
    const buttons = Object.entries(iconThemes()).map(([name, t]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t.symbol || t.label[0];
      b.title = b.ariaLabel = `${t.label} trees`;
      b.onclick = () => setIconTheme(name);
      div.append(b);
      return [name, b];
    });
    this.update = () => buttons.forEach(([name, b]) => b.classList.toggle('active', name === S.iconTheme));
    this.update();
    S.seasonControl = this;
    return div;
  }
  onRemove() {}
}

// Symbol layer showing `image` (default: id) at the crown diameter given in metres, never below minPx.
function iconLayer(id, source, diameter, minPx, opacity, image = id) {
  // at icon-size 1 the disc shows ICON_DISC_PX / ICON_RATIO screen pixels wide
  const perMetre = z => (2 ** z / (156543.03 * Math.cos(S.cfg.center[1] * NG.DEG))) / (ICON_DISC_PX / ICON_RATIO);
  const size = z => ['max', minPx / (ICON_PX / ICON_RATIO), ['*', diameter, perMetre(z)]];
  return {id, type: 'symbol', source,
          layout: {'icon-image': image, 'icon-size': ['interpolate', ['exponential', 2], ['zoom'], 12, size(12), 22, size(22)],
                   'icon-allow-overlap': true, 'icon-ignore-placement': true,
                   'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map'},
          paint: {'icon-opacity': opacity}};
}

// circle-radius expression for a radius in metres (exact at the configured centre latitude)
function metres(expr, minPx = 0) {
  const px = z => 2 ** z / (156543.03 * Math.cos(S.cfg.center[1] * NG.DEG));
  return ['interpolate', ['exponential', 2], ['zoom'], 12, ['max', minPx, ['*', expr, px(12)]], 22, ['max', minPx, ['*', expr, px(22)]]];
}

const num = x => (x == null || x === '' ? NaN : typeof x === 'number' ? x : parseFloat(String(x).replace(',', '.')));
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const signed = (v, digits = 1) => { const r = +v.toFixed(digits); return (r > 0 ? '+' : r < 0 ? '−' : '±') + Math.abs(r).toFixed(digits); };
const compass = deg => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
const fc = features => ({type: 'FeatureCollection', features});
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const box = (p, r) => [[p.x - r, p.y - r], [p.x + r, p.y + r]];
const setData = (id, data) => S.map.getSource(id).setData(data);
const getJSON = async url => (await fetch(url, {cache: 'no-store'})).json();
function setStatus(msg, error = false) { $('status').textContent = msg; $('status').classList.toggle('err', error); }
function hint(msg) { $('hint').textContent = msg; }
function blankPng() { const c = document.createElement('canvas'); c.width = c.height = 1; return c.toDataURL(); }

main().catch(e => setStatus(e.message, true));
