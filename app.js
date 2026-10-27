'use strict';
// Map, data loading, street selection, tree placement and UI.
// Physics: model.js. Rasterising: worker.js. Everything configurable: config/*.json.

const BASEMAP = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const RAMP = ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#b10026'];
const STITCH_TOLERANCE_M = 2;
const MIN_SELECT_ZOOM = 14.5;

const $ = id => document.getElementById(id);
const S = {
  cfg: null, model: null, map: null, popup: null,
  overlay: null, records: [], hasTime: false, extent: null, domain: null,   // heat overlay
  roadLayers: [], roadSource: null,
  street: null,          // {name, line, xy, cum, length, halfWidth, obstacles, a, b}
  mode: 'even',          // tree placement: 'even' | 'manual'
  manual: [],            // [{lon, lat}] trees placed by hand
  placement: {key: null, trees: []},
  draw: {active: false, drawing: false, ring: []},
  layerData: {}, existingTrees: [],
  job: 0, timer: null, refresh: null, url: null,
};
const worker = new Worker('worker.js');

async function main() {
  [S.cfg, S.model] = await Promise.all([getJSON('config/overlays.json'), getJSON('config/model.json')]);
  S.map = new maplibregl.Map({container: 'map', style: BASEMAP, center: S.cfg.center, zoom: S.cfg.zoom, hash: true});
  S.map.addControl(new maplibregl.NavigationControl({showCompass: false}), 'top-right');
  S.map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
  await S.map.once('style.load');  // don't wait for every basemap tile
  setupMap();
  setupUi();
  setupDataLayers();
  await loadOverlay(S.cfg.overlays[0]);
}

// ------------------------------------------------------------------ map setup

function setupMap() {
  const m = S.map, layers = m.getStyle().layers;
  const roads = layers.filter(l => l['source-layer'] === 'roads' && l.type === 'line' && !/rail|aeroway/.test(l.id));
  S.roadLayers = roads.map(l => l.id);
  S.roadSource = roads[0].source;
  const firstRoad = roads[0].id;
  const firstLabel = layers.slice(layers.findIndex(l => l.id === firstRoad)).find(l => l.type === 'symbol').id;

  m.addSource('heat', {type: 'image', url: blankPng(), coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]]});
  m.addLayer({id: 'heat', type: 'raster', source: 'heat', paint: {'raster-opacity': 0.72, 'raster-fade-duration': 0}}, firstRoad);

  for (const id of ['section', 'shadows', 'planted', 'lasso']) m.addSource(id, {type: 'geojson', data: fc([])});
  m.addLayer({id: 'section', type: 'line', source: 'section', layout: {'line-cap': 'round'},
              paint: {'line-color': '#1c7ed6', 'line-opacity': 0.3, 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 14, 4, 20, 90]}}, firstLabel);
  m.addLayer({id: 'lasso', type: 'line', source: 'lasso',
              paint: {'line-color': '#1c7ed6', 'line-width': 2, 'line-dasharray': [2, 2]}}, firstLabel);
  m.addLayer({id: 'shadows', type: 'fill', source: 'shadows', paint: {'fill-color': '#102030', 'fill-opacity': 0.3}}, firstLabel);
  m.addLayer({id: 'planted', type: 'circle', source: 'planted', paint: {
    'circle-color': '#2f9e44', 'circle-opacity': 0.9, 'circle-stroke-color': '#0b3d16', 'circle-stroke-width': 1.5,
    'circle-radius': metres(['get', 'r'], 4)}}, firstLabel);

  S.popup = new maplibregl.Popup({closeButton: false, closeOnClick: false, offset: 10, maxWidth: '260px'});
  m.on('moveend', update);
  m.on('click', onClick);
  m.on('mousemove', e => {
    if (S.draw.active) return;
    const layers = S.street && S.mode === 'manual' ? ['planted'] : S.roadLayers;
    const hit = m.getZoom() >= MIN_SELECT_ZOOM && m.queryRenderedFeatures(box(e.point, 10), {layers}).length;
    m.getCanvas().style.cursor = hit ? 'pointer' : S.street && S.mode === 'manual' ? 'copy' : '';
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
  for (const id of ['date', 'time', 'trees', 'preset']) $(id).oninput = update;
  for (const r of document.querySelectorAll('input[name=mode]')) r.onchange = () => setMode(r.value);
  $('clearTrees').onclick = () => { S.manual = []; update(); };
  $('drawBtn').onclick = () => setDrawMode(!S.draw.active);
  $('close').onclick = closeScenario;
  addEventListener('keydown', e => { if (e.key === 'Escape') setDrawMode(false); });
}

function onClick(e) {
  if (S.draw.active) return;
  if (S.street && S.mode === 'manual') return toggleManualTree(e);
  pickStreet(e);
}

// ------------------------------------------------------------------ street selection: click

// Click a street: select all of it (as far as it is loaded).
function pickStreet(e) {
  if (S.map.getZoom() < MIN_SELECT_ZOOM) return setStatus('Zoom in further to select a street.');
  const hits = S.map.queryRenderedFeatures(box(e.point, 10), {layers: S.roadLayers});
  const hit = hits.find(f => f.properties.name) || hits[0];
  if (!hit) return;
  const click = [e.lngLat.lng, e.lngLat.lat];
  const line = streetLines(hit).sort((a, b) => turf.pointToLineDistance(click, a) - turf.pointToLineDistance(click, b))[0];
  if (line) selectStreet(hit, line, 0, Infinity);
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
  S.street = {...g, name: hit.properties.name || 'Unnamed way', line, halfWidth: roadHalfWidth(hit.properties),
              a: Math.max(0, a), b: Math.min(g.length, b), obstacles: collectObstacles(turf.bbox(line), P)};
  S.manual = [];
  S.placement.key = null;
  $('street').textContent = S.street.name;
  $('scenario').hidden = false;
  setStatus('');
  const sec = sectionLine(P);
  if (innerWidth > 900) {  // keep the section clear of both panels, never zoom in
    S.map.fitBounds(turf.bbox(sec), {padding: {top: 80, bottom: 80, left: 320, right: 360}, maxZoom: Math.max(S.map.getZoom(), 17), duration: 600});
  }
  update();
}

function closeScenario() {
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
  if (S.placement.key !== key) S.placement = {key, trees: placeEvenly(n, size.crown_diameter_m / 2, P).map(withSize)};
  return S.placement.trees;
}

// Evenly spaced on alternating sides. A blocked spot first moves away from the centre line
// (real streets are often wider than their class suggests, e.g. tram tracks in a pedestrian
// zone) but never past a building or water, then slides along the street until one fits.
function placeEvenly(n, r, P) {
  const st = S.street, pl = S.model.placement, placed = [];
  const start = (st.halfWidth || pl.path_offset_m) + pl.clearance_m + 0.5;
  const spacing = (st.b - st.a) / Math.max(n, 1), reach = Math.max(2, spacing / 2);
  for (let i = 0; i < n; i++) {
    const d0 = st.a + (i + 0.5) * spacing, sides = i % 2 ? [-1, 1] : [1, -1];
    search: for (let k = 0; k <= reach; k++) {
      for (const d of k ? [d0 + k, d0 - k] : [d0]) {
        if (d < st.a || d > st.b) continue;
        const q = alongXY(st, d);
        for (const side of sides) {
          for (let off = start; off <= Math.max(start, pl.max_offset_m); off += 0.5) {
            const p = {x: q.x - q.ty * side * off, y: q.y + q.tx * side * off};
            const why = blocked(p, r, placed, st.obstacles);
            if (!why) { placed.push(p); break search; }
            if (why === 'building' || why === 'water') break;
          }
        }
      }
    }
  }
  return placed.map(p => { const [lon, lat] = P.toLL(p.x, p.y); return {lon, lat}; });
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
  for (const t of o.trees) if (Math.hypot(p.x - t.x, p.y - t.y) < (t.r + r) * pl.crown_overlap) return 'existing tree';
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
  for (const [group, list] of groups) {
    const label = document.createElement('label');
    label.textContent = group;
    const sel = document.createElement('select');
    sel.add(new Option('– off –', ''));
    for (const l of list) sel.add(new Option(l.label, l.id));
    sel.onchange = () => list.forEach(l => showLayer(l, l.id === sel.value));
    $('layers').append(label, sel, ...list.map(legendFor));
  }
}

async function showLayer(l, on) {
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
    S.map.addLayer(layerStyle(l, id), 'section');
    S.map.on('mousemove', id, e => tooltip(l, e));
    S.map.on('mouseleave', id, () => S.popup.remove());
  }
  S.map.setLayoutProperty(id, 'visibility', 'visible');
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
  const radius = crown
    ? metres(['/', ['to-number', ['get', l.crownDiameterField], S.model.placement.default_existing_crown_m], 2], 1.5)
    : ['interpolate', ['linear'], ['zoom'], 12, 2, 18, 7];
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
    return (Math.abs(n) >= 100 ? Math.round(n) : +n.toFixed(2)).toLocaleString('en');
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

  $('ramp').style.background = `linear-gradient(90deg, ${RAMP.join(',')})`;
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
    const P = NG.projection(...S.cfg.center), section = sectionLine(P), trees = currentTrees(P);
    const shadows = trees.map(t => NG.shadowEllipse({...t, ...P.toXY(t.lon, t.lat)}, sun, S.model)).filter(Boolean)
      .map(e => { const ring = NG.ellipseRing(e).map(([x, y]) => P.toLL(x, y)); return turf.polygon([[...ring, ring[0]]]); });
    setData('section', fc([section]));
    setData('planted', fc(trees.map((t, i) => turf.point([t.lon, t.lat], {r: t.crown_diameter_m / 2, i}))));
    setData('shadows', fc(shadows));
    const len = Math.round(S.street.b - S.street.a), n = +$('trees').value;
    $('secLabel').textContent = `Section: ${len} m` + (S.street.b - S.street.a < S.street.length - 1 ? ` of ${Math.round(S.street.length)} m` : '');
    $('treeLabel').textContent = !n ? 'none' : trees.length === n ? `${n} · every ${Math.round(len / n)} m` : `${trees.length} of ${n} fit`;
    $('manualCount').textContent = `${S.manual.length} ${S.manual.length === 1 ? 'tree' : 'trees'} placed`;
    scenario = {trees, section: section.geometry.coordinates, sun};
  } else {
    for (const id of ['section', 'planted', 'shadows']) setData(id, fc([]));
  }

  const points = currentPoints();
  if (!points.length) setStatus('No measurements at this time of day.', true);
  const b = S.map.getBounds(), padX = (b.getEast() - b.getWest()) * 0.25, padY = (b.getNorth() - b.getSouth()) * 0.25;
  const view = [b.getWest() - padX, b.getSouth() - padY, b.getEast() + padX, b.getNorth() + padY];
  const canvas = S.map.getCanvas(), W = Math.min(900, Math.round(canvas.clientWidth * 0.75));
  const H = Math.max(1, Math.round((W * canvas.clientHeight) / canvas.clientWidth));
  worker.postMessage({id: ++S.job, points, origin: S.cfg.center, extent: S.extent, view, size: [W, H],
                      domain: S.domain, ramp: RAMP, params: S.model, scenario});
  S.lastTrees = scenario ? scenario.trees.length : 0;
}

worker.onmessage = ({data}) => {
  if (data.id !== S.job) return;  // a newer request is already on its way
  if (data.image) {
    const old = S.url;
    S.url = URL.createObjectURL(data.image.blob);
    S.map.getSource('heat').updateImage({url: S.url, coordinates: data.image.coordinates});
    if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
  }
  S.map.setLayoutProperty('heat', 'visibility', data.image ? 'visible' : 'none');
  showResult(data.stats);
};

function showResult(st) {
  const unit = S.overlay.unit || '', n = S.lastTrees;
  const rows = !st ? [['No values along the street', '']] : [
    ['Mean before', `${st.before.toFixed(1)} ${unit}`],
    ['Mean with trees', `${st.after.toFixed(1)} ${unit}`],
    ['Change', `${signed(st.after - st.before)} K`, 'big'],
    ['Strongest cooling', `${signed(st.maxCooling)} K`],
    ['Shaded', `${Math.round(st.shadedArea).toLocaleString('en')} of ${Math.round(st.area).toLocaleString('en')} m²`],
    ['Cost (assumed)', `€${(n * S.model.cost_per_tree_eur).toLocaleString('en')}`],
  ];
  $('result').innerHTML = rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ''}">${v}</dd>`).join('') +
    `<dt class="muted" style="grid-column:1/-1">Mean within ${S.model.street_corridor_m} m on both sides of the section</dt>`;
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

// circle-radius expression for a radius in metres (exact at the configured centre latitude)
function metres(expr, minPx = 0) {
  const px = z => 2 ** z / (156543.03 * Math.cos(S.cfg.center[1] * NG.DEG));
  return ['interpolate', ['exponential', 2], ['zoom'], 12, ['max', minPx, ['*', expr, px(12)]], 22, ['max', minPx, ['*', expr, px(22)]]];
}

const num = x => (x == null || x === '' ? NaN : typeof x === 'number' ? x : parseFloat(String(x).replace(',', '.')));
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const signed = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1);
const compass = deg => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
const fc = features => ({type: 'FeatureCollection', features});
const box = (p, r) => [[p.x - r, p.y - r], [p.x + r, p.y + r]];
const setData = (id, data) => S.map.getSource(id).setData(data);
const getJSON = async url => (await fetch(url, {cache: 'no-store'})).json();
function setStatus(msg, error = false) { $('status').textContent = msg; $('status').classList.toggle('err', error); }
function hint(msg) { $('hint').textContent = msg; }
function blankPng() { const c = document.createElement('canvas'); c.width = c.height = 1; return c.toDataURL(); }

main().catch(e => setStatus(e.message, true));
