'use strict';
// Map, data loading, street selection and UI. Physics: model.js. Rasterising: worker.js.

const BASEMAP = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const RAMP = ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#b10026'];
const STITCH_TOLERANCE_M = 2;
const MIN_SELECT_ZOOM = 14.5;
const HOTSPOT_ZOOM = 17;
const HOTSPOT_SECTION_M = 200;  // section preselected around a hotspot

const $ = id => document.getElementById(id);
const S = {cfg: null, model: null, overlay: null, records: [], hasTime: false, extent: null, domain: null,
           street: null, roadLayers: [], roadSource: null, job: 0, timer: null, refresh: null, url: null};
const worker = new Worker('worker.js');

async function main() {
  [S.cfg, S.model] = await Promise.all([getJSON('config/overlays.json'), getJSON('config/model.json')]);
  S.map = new maplibregl.Map({container: 'map', style: BASEMAP, center: S.cfg.center, zoom: S.cfg.zoom, hash: true});
  S.map.addControl(new maplibregl.NavigationControl({showCompass: false}), 'top-right');
  S.map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
  await S.map.once('style.load');  // don't wait for every basemap tile
  setupLayers();
  setupUi();
  loadHotspots();
  await loadOverlay(S.cfg.overlays[0], {initial: true});
}

// ------------------------------------------------------------------ map layers

function setupLayers() {
  const m = S.map, layers = m.getStyle().layers;
  const roads = layers.filter(l => l['source-layer'] === 'roads' && l.type === 'line' && !/rail|aeroway/.test(l.id));
  S.roadLayers = roads.map(l => l.id);
  S.roadSource = roads[0].source;
  const firstRoad = roads[0].id;
  const firstLabel = layers.slice(layers.findIndex(l => l.id === firstRoad)).find(l => l.type === 'symbol').id;

  m.addSource('heat', {type: 'image', url: blankPng(), coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]]});
  m.addLayer({id: 'heat', type: 'raster', source: 'heat', paint: {'raster-opacity': 0.72, 'raster-fade-duration': 0}}, firstRoad);

  for (const id of ['section', 'shadows', 'trees']) m.addSource(id, {type: 'geojson', data: fc([])});
  m.addLayer({id: 'section', type: 'line', source: 'section', layout: {'line-cap': 'round'},
              paint: {'line-color': '#1c7ed6', 'line-opacity': 0.25, 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 14, 4, 20, 90]}}, firstLabel);
  m.addLayer({id: 'shadows', type: 'fill', source: 'shadows', paint: {'fill-color': '#102030', 'fill-opacity': 0.3}}, firstLabel);
  const px = z => 2 ** z / (156543.03 * Math.cos(S.cfg.center[1] * NG.DEG));  // pixels per metre
  m.addLayer({id: 'trees', type: 'circle', source: 'trees', paint: {
    'circle-color': '#2f9e44', 'circle-opacity': 0.85, 'circle-stroke-color': '#1b5e20', 'circle-stroke-width': 1,
    'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 12, ['*', ['get', 'r'], px(12)], 22, ['*', ['get', 'r'], px(22)]]}}, firstLabel);

  const font = layers.find(l => l.layout && l.layout['text-font'])?.layout['text-font'];
  m.addSource('hotspots', {type: 'geojson', data: fc([])});
  m.addLayer({id: 'hotspots', type: 'circle', source: 'hotspots', paint: {
    'circle-radius': 9, 'circle-color': '#c92a2a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2}});
  m.addLayer({id: 'hotspot-labels', type: 'symbol', source: 'hotspots', layout: {
    'text-field': ['to-string', ['get', 'rang']], 'text-font': font, 'text-size': 11, 'text-allow-overlap': true},
    paint: {'text-color': '#fff'}});

  m.on('moveend', update);
  m.on('click', pickStreet);
  m.on('mousemove', e => {
    const hit = m.getZoom() >= MIN_SELECT_ZOOM && m.queryRenderedFeatures(box(e.point, 10), {layers: S.roadLayers}).length;
    m.getCanvas().style.cursor = hit ? 'pointer' : '';
  });
}

function setupUi() {
  for (const o of S.cfg.overlays) $('overlay').add(new Option(o.label, o.id));
  $('overlay').onchange = e => loadOverlay(S.cfg.overlays.find(o => o.id === e.target.value));
  for (const [k, p] of Object.entries(S.model.presets)) $('preset').add(new Option(p.label, k));
  $('preset').value = S.model.default_preset;
  $('trees').max = S.model.max_trees;
  $('trees').value = S.model.default_trees;
  $('date').value = new Date().toISOString().slice(0, 10);
  for (const id of ['date', 'time', 'secStart', 'secEnd', 'trees', 'preset']) $(id).oninput = update;
  $('close').onclick = () => { S.street = null; $('scenario').hidden = true; update(); };
}

// ------------------------------------------------------------------ data

async function loadOverlay(o, {initial = false, refresh = false} = {}) {
  if (!refresh) setStatus('Lade Daten …');
  let records;
  try {
    records = await loadRecords(o);
    if (!records.length) throw new Error('keine Messwerte');
  } catch (e) {
    setStatus(`„${o.label}“ nicht verfügbar: ${e.message}`, true);
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

  $('ramp').style.background = `linear-gradient(90deg, ${RAMP.join(',')})`;
  $('dmin').textContent = S.domain[0].toFixed(0);
  $('dmax').textContent = S.domain[1].toFixed(0);
  $('unit').textContent = o.unit || '';
  setStatus(`${records.length.toLocaleString('de')} Messwerte` +
            (o.refreshSeconds ? ` · Stand ${new Date().toLocaleTimeString('de', {hour: '2-digit', minute: '2-digit'})}` : ''));

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

// ------------------------------------------------------------------ street selection

function pickStreet(e) {
  if (S.map.getZoom() < MIN_SELECT_ZOOM) return setStatus('Zum Auswählen einer Straße näher heranzoomen.');
  const hits = S.map.queryRenderedFeatures(box(e.point, e.radius || 10), {layers: S.roadLayers});
  const hit = hits.find(f => e.name && f.properties.name === e.name) || hits.find(f => f.properties.name) || hits[0];
  if (!hit) return;
  const name = hit.properties.name;
  // Tiles cut streets into pieces: collect every loaded piece with the same name and join them.
  const feats = name ? S.map.querySourceFeatures(S.roadSource, {sourceLayer: 'roads', filter: ['==', ['get', 'name'], name]}) : [hit];
  const lines = stitch(feats.flatMap(f => f.geometry.type === 'LineString' ? [f.geometry.coordinates]
                                         : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : []));
  const click = [e.lngLat.lng, e.lngLat.lat];
  const line = lines.map(c => turf.lineString(c))
                    .sort((a, b) => turf.pointToLineDistance(click, a) - turf.pointToLineDistance(click, b))[0];
  if (!line) return;
  S.street = {name: name || 'Unbenannter Weg', line, length: turf.length(line, {units: 'meters'})};
  $('street').textContent = S.street.name;
  $('secStart').value = 0;
  $('secEnd').value = 100;
  $('scenario').hidden = false;
  if (innerWidth > 900) {  // keep the street clear of both panels, never zoom in
    S.map.fitBounds(turf.bbox(line), {padding: {top: 60, bottom: 60, left: 310, right: 350}, maxZoom: S.map.getZoom(), duration: 600});
  }
  update();
}

// ------------------------------------------------------------------ hotspots

// Warm street spots found in the bike rides by scripts/find_hotspots.py; a click selects the street there.
async function loadHotspots() {
  if (!S.cfg.hotspots) return;
  let gj;
  try { gj = await getJSON(S.cfg.hotspots); } catch { return; }
  setData('hotspots', gj);
  $('hotspots').replaceChildren(...gj.features.map(f => {
    const p = f.properties, li = document.createElement('li'), b = document.createElement('button');
    const name = document.createElement('span'), val = document.createElement('b');
    name.textContent = `${p.rang}. ${p.strasse}`;
    val.textContent = `${signed(p.anomalie_K)} K`;
    b.title = `${p.fahrten} Fahrten von ${p.raeder} Rädern, Ø ${p.temperatur_mittel} °C (± ${p.fehler_K} K)`;
    b.append(name, val);
    b.onclick = () => goToHotspot(f);
    li.append(b);
    return li;
  }));
  const day = s => s.split('-').reverse().join('.');
  $('hotspotNote').textContent = 'Wärmer als der Rest derselben Fahrt' + (gj.meta ? `, ${day(gj.meta.von)} – ${day(gj.meta.bis)}` : '') + '.';
  $('hotspotBox').hidden = false;
}

function goToHotspot(f) {
  const ll = f.geometry.coordinates, previous = S.street;
  S.map.flyTo({center: ll, zoom: Math.max(S.map.getZoom(), HOTSPOT_ZOOM)});
  S.map.once('idle', () => {
    pickStreet({point: S.map.project(ll), lngLat: {lng: ll[0], lat: ll[1]}, radius: 25, name: f.properties.strasse});
    if (S.street === previous) return setStatus('Keine Straße am Hotspot gefunden, bitte direkt anklicken.', true);
    const at = turf.nearestPointOnLine(S.street.line, ll, {units: 'meters'}).properties.location;
    const pct = m => Math.round(Math.min(100, Math.max(0, (m / S.street.length) * 100)));
    $('secStart').value = pct(at - HOTSPOT_SECTION_M / 2);
    $('secEnd').value = pct(at + HOTSPOT_SECTION_M / 2);
    update();
  });
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

function scenarioGeometry() {
  const {line, length} = S.street;
  let a = (+$('secStart').value / 100) * length, b = (+$('secEnd').value / 100) * length;
  if (a > b) [a, b] = [b, a];
  b = Math.max(b, Math.min(length, a + 5));
  const n = +$('trees').value, size = S.model.presets[$('preset').value];
  const trees = Array.from({length: n}, (_, i) => {
    const [lon, lat] = turf.along(line, a + ((i + 0.5) * (b - a)) / n, {units: 'meters'}).geometry.coordinates;
    return {lon, lat, height_m: size.height_m, crown_diameter_m: size.crown_diameter_m};
  });
  return {section: turf.lineSliceAlong(line, a, b, {units: 'meters'}), trees, from: a, to: b};
}

// ------------------------------------------------------------------ update loop

function update() {
  clearTimeout(S.timer);
  S.timer = setTimeout(run, 30);
}

function run() {
  if (!S.overlay) return;
  const minute = +$('time').value;
  $('timeLabel').textContent = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')} Uhr`;
  const sun = sunPosition();
  const alt = sun.altitude / NG.DEG, bearing = (sun.azimuth / NG.DEG + 180 + 360) % 360;
  $('sun').textContent = alt > 0 ? `Sonne: ${alt.toFixed(0)}° hoch, aus ${compass(bearing)} (${bearing.toFixed(0)}°)` : 'Sonne unter dem Horizont';

  let scenario = null;
  if (S.street) {
    const g = scenarioGeometry(), P = NG.projection(...S.cfg.center);
    const shadows = g.trees.map(t => NG.shadowEllipse({...t, ...P.toXY(t.lon, t.lat)}, sun, S.model)).filter(Boolean)
      .map(e => { const ring = NG.ellipseRing(e).map(([x, y]) => P.toLL(x, y)); return turf.polygon([[...ring, ring[0]]]); });
    setData('section', fc([g.section]));
    setData('trees', fc(g.trees.map(t => turf.point([t.lon, t.lat], {r: t.crown_diameter_m / 2}))));
    setData('shadows', fc(shadows));
    $('secLabel').textContent = `${Math.round(g.to - g.from)} m von ${Math.round(S.street.length)} m`;
    $('treeLabel').textContent = g.trees.length ? `${g.trees.length} · alle ${Math.round((g.to - g.from) / g.trees.length)} m` : 'keine';
    scenario = {trees: g.trees, section: g.section.geometry.coordinates, sun};
  } else {
    for (const id of ['section', 'trees', 'shadows']) setData(id, fc([]));
  }

  const points = currentPoints();
  if (!points.length) setStatus('Zu dieser Uhrzeit gibt es keine Messwerte.', true);
  const b = S.map.getBounds(), padX = (b.getEast() - b.getWest()) * 0.25, padY = (b.getNorth() - b.getSouth()) * 0.25;
  const view = [b.getWest() - padX, b.getSouth() - padY, b.getEast() + padX, b.getNorth() + padY];
  const canvas = S.map.getCanvas(), W = Math.min(900, Math.round(canvas.clientWidth * 0.75));
  const H = Math.max(1, Math.round((W * canvas.clientHeight) / canvas.clientWidth));
  worker.postMessage({id: ++S.job, points, origin: S.cfg.center, extent: S.extent, view, size: [W, H],
                      domain: S.domain, ramp: RAMP, params: S.model, scenario});
}

worker.onmessage = ({data}) => {
  if (data.id !== S.job) return;  // a newer request is already on its way
  const src = S.map.getSource('heat');
  if (data.image) {
    const old = S.url;
    S.url = URL.createObjectURL(data.image.blob);
    src.updateImage({url: S.url, coordinates: data.image.coordinates});
    if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
  }
  S.map.setLayoutProperty('heat', 'visibility', data.image ? 'visible' : 'none');
  showResult(data.stats);
};

function showResult(st) {
  const unit = S.overlay.unit || '';
  const n = +$('trees').value;
  const rows = !st ? [['Keine Werte im Straßenraum', '']] : [
    ['Ø vorher', `${st.before.toFixed(1)} ${unit}`],
    ['Ø mit Bäumen', `${st.after.toFixed(1)} ${unit}`],
    ['Änderung', `${signed(st.after - st.before)} K`, 'big'],
    ['stärkste Abkühlung', `${signed(st.maxCooling)} K`],
    ['beschattet', `${Math.round(st.shadedArea).toLocaleString('de')} m² von ${Math.round(st.area).toLocaleString('de')} m²`],
    ['Kosten (Annahme)', `${(n * S.model.cost_per_tree_eur).toLocaleString('de')} €`],
  ];
  $('result').innerHTML = rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ''}">${v}</dd>`).join('') +
    `<dt class="muted" style="grid-column:1/-1">Mittel über ${S.model.street_corridor_m} m beidseits des Abschnitts</dt>`;
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

const num = x => (x == null || x === '' ? NaN : typeof x === 'number' ? x : parseFloat(String(x).replace(',', '.')));
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const signed = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1);
const compass = deg => ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
const fc = features => ({type: 'FeatureCollection', features});
const box = (p, r) => [[p.x - r, p.y - r], [p.x + r, p.y + r]];
const setData = (id, data) => S.map.getSource(id).setData(data);
const getJSON = async url => (await fetch(url, {cache: 'no-store'})).json();
function setStatus(msg, error = false) { $('status').textContent = msg; $('status').classList.toggle('err', error); }
function blankPng() { const c = document.createElement('canvas'); c.width = c.height = 1; return c.toDataURL(); }

main().catch(e => setStatus(e.message, true));
