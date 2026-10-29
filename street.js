'use strict';
// Street view: place trees and vehicles into views of a street from the centre of the road.
// The views are AI images (scripts/centre_view.py), the trees and vehicles realistic cut-outs
// (scripts/make_sprites.py). Camera model, ground mapping and drawing here; tree shadows from
// model.js; views and their calibration in config/street.json ("centre_views").

const HANDOFF_KEY = 'ng-street-handoff';   // read by app.js
const STORE_KEY = 'ng-street-items';  // one list for the whole street, in world metres
const SPRITES = 'data/street/sprites/sprites.json';
const MIN_DISTANCE_M = 2;
const TREE_KERB_M = 0.5;   // trunk at least this far behind the kerb, on the footpath
const KERB_GAP_M = 0.2;     // vehicles keep this far inside the kerb, bicycles this far behind it
const TREE_BICYCLE_M = 1.0;  // a bicycle keeps this far from a trunk
// size: length along the street and width (m); gap: to the next vehicle in front/behind and beside;
// lamps: [across, height] in metres, front and rear, as seen from that end; place: road or footpath;
// box: drawn in perspective as its near end and its long side (see drawBox), as it is long enough
// that a flat view from one end would point it off its lane wherever it is not straight ahead
const VEHICLES = {
  car: {size: [4.4, 1.8], gap: [1.0, 0.5], place: 'road', front: [[-0.62, 0.68], [0.62, 0.68]], rear: [[-0.68, 0.72], [0.68, 0.72]]},
  bus: {size: [12, 2.55], gap: [1.5, 0.5], place: 'road', box: true, front: [[-1.0, 0.9], [1.0, 0.9]], rear: [[-1.05, 1.05], [1.05, 1.05]]},
  motorbike: {size: [2.1, 0.8], gap: [1.0, 0.4], place: 'road', front: [[0, 0.95]], rear: [[0, 0.85]]},
  bicycle: {size: [1.8, 0.6], gap: [0.5, 0.3], place: 'footpath', front: [[0, 0.9]], rear: [[0, 0.75]]},
};
const TOOLS = [
  {id: 'small', label: 'Small tree', kind: 'tree'},
  {id: 'medium', label: 'Medium tree', kind: 'tree'},
  {id: 'large', label: 'Large tree', kind: 'tree'},
  {id: 'car', label: 'Car', kind: 'car'},
  {id: 'bus', label: 'Bus', kind: 'bus'},
  {id: 'motorbike', label: 'Motorbike', kind: 'motorbike'},
  {id: 'bicycle', label: 'Bicycle', kind: 'bicycle'},
  {id: 'remove', label: 'Remove', kind: null},
];
const isVehicle = kind => kind in VEHICLES;

const $ = id => document.getElementById(id);
const DEG = Math.PI / 180;
const S = {
  cfg: null, model: null,
  view: null, cam: null, img: null, imgs: {},
  items: [],             // trees and vehicles of the whole street: [{kind, preset, east, north, seed}], metres from the views' common camera point
  tool: 'medium', hover: null, rects: [], sprites: {},  // sprite id -> {img, ground, px_per_m, ...}
  resultKey: null,
  ground: null, foreground: [], frame: 0, debug: new URLSearchParams(location.search).has('debug'),
};

async function main() {
  let sprites;
  [S.cfg, S.model, sprites] = await Promise.all([getJSON('config/street.json'), getJSON('config/model.json'), getJSON(SPRITES)]);
  S.views = S.cfg.centre_views;
  await Promise.all(Object.entries(sprites).map(async ([id, sp]) => { S.sprites[id] = {...sp, img: await loadImage(sp.image)}; }));
  S.ctx = $('photo').getContext('2d');
  S.items = loadItems();
  setupUi();
  const wanted = new URLSearchParams(location.search).get('view');
  await showView((S.views.find(v => v.id === wanted) || S.views[0]).id);
}

// ------------------------------------------------------------------ camera
// Pinhole camera at height h, no roll, pitched down so the horizon sits at horizon_y.
// Camera frame: x right, z forward (level), metres; ground points are {x, z}.

function camera(v, W, H) {
  const f = v.focal_px, cx = W / 2, cy = H / 2, h = v.camera_height_m;
  const pitch = Math.atan((cy - v.horizon_y) / f), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const yaw = Math.atan(((v.vanishing_x - cx) * cp) / f);  // street direction relative to the optical axis
  const bearing = v.street_bearing_deg * DEG - yaw;         // compass bearing of the optical axis
  const sb = Math.sin(bearing), cb = Math.cos(bearing), kx = 111320 * Math.cos(v.lat * DEG);
  return {
    f, h, bearing,
    toGround(u, w) {
      const x = (u - cx) / f, y = (w - cy) / f, Y = y * cp + sp, Z = -y * sp + cp;
      return Y > 1e-6 ? {x: (h / Y) * x, z: (h / Y) * Z} : null;
    },
    // point `up` metres above the ground; scale = pixels per metre at that depth
    project(x, up, z) {
      const Y = h - up, yc = Y * cp - z * sp, zc = Y * sp + z * cp;
      return zc > 0.2 ? {u: cx + (f * x) / zc, v: cy + (f * yc) / zc, scale: f / zc} : null;
    },
    toEN: p => ({east: p.x * cb + p.z * sb, north: -p.x * sb + p.z * cb}),
    fromEN: (east, north) => ({x: east * cb - north * sb, z: east * sb + north * cb}),
    toLL(p) { const {east, north} = this.toEN(p); return [v.lon + east / kx, v.lat + north / 111320]; },
  };
}

// ------------------------------------------------------------------ views and UI

function setupUi() {
  for (const v of S.views) {
    const b = document.createElement('button');
    b.textContent = v.label;
    b.dataset.id = v.id;
    b.onclick = () => showView(v.id);
    $('views').append(b);
  }
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.textContent = t.label;
    b.dataset.id = t.id;
    b.onclick = () => { S.tool = t.id; markTools(); };
    $('tools').append(b);
  }
  markTools();
  $('title').textContent = `${S.cfg.street} – street view`;
  $('date').value = S.cfg.default_date;
  $('time').value = S.cfg.default_time_min;
  for (const id of ['date', 'time', 'shadows']) $(id).oninput = draw;
  $('clear').onclick = () => { S.items = []; saveItems(); draw(); };
  $('demo').onclick = demoScene;
  $('save').onclick = saveImage;
  $('toMap').onclick = toMap;

  const c = $('photo');
  c.addEventListener('pointermove', e => { S.hover = placeable(imagePoint(e)); draw(); });
  c.addEventListener('pointerleave', () => { S.hover = null; draw(); });
  c.addEventListener('click', e => onClick(imagePoint(e)));
}

function markTools() {
  for (const b of $('tools').children) b.classList.toggle('on', b.dataset.id === S.tool);
  $('photo').style.cursor = S.tool === 'remove' ? 'not-allowed' : 'crosshair';
}

async function showView(id) {
  const v = S.views.find(x => x.id === id);
  if (!S.imgs[id]) {
    S.imgs[id] = new Image();
    S.imgs[id].src = v.image;
    await S.imgs[id].decode();
  }
  S.view = v;
  S.img = S.imgs[id];
  const W = S.img.naturalWidth, H = S.img.naturalHeight;
  S.cam = camera(v, W, H);
  S.ground = path(v.ground);
  // distance of each kerb from the centre line, from one image point on it (config "kerbs")
  S.kerb = {left: lateral(S.cam.toGround(...v.kerbs.left)), right: lateral(S.cam.toGround(...v.kerbs.right))};
  S.foreground = v.foreground.map(path);
  $('photo').width = W;
  $('photo').height = H;
  for (const b of $('views').children) b.classList.toggle('on', b.dataset.id === id);
  $('viewNote').textContent = v.description;
  draw();
}

function imagePoint(e) {
  const c = $('photo'), r = c.getBoundingClientRect();
  return {u: ((e.clientX - r.left) * c.width) / r.width, v: ((e.clientY - r.top) * c.height) / r.height};
}

// Ground point under an image point if something can be placed there, else null.
function placeable(pt) {
  return spot(pt).p || null;
}

// Where the current tool may go: trees on the footpath, cars on the road.
// {p} if allowed, otherwise {why} for the hint.
function spot({u, v}) {
  if (S.tool === 'remove') return {why: 'Click a tree trunk or a vehicle to remove it.'};
  const p = S.ctx.isPointInPath(S.ground, u, v) && S.cam.toGround(u, v);
  if (!p || Math.hypot(p.x, p.z) < MIN_DISTANCE_M || Math.hypot(p.x, p.z) > S.cfg.max_distance_m) {
    return {why: `Click the footpath or the road, up to ${S.cfg.max_distance_m} m away.`};
  }
  const tool = TOOLS.find(t => t.id === S.tool), l = lateral(p), s = along(p), {left, right} = S.kerb;
  const all = viewObjects(), trees = all.filter(o => o.kind === 'tree');  // includes those behind the camera
  const bikes = all.filter(o => o.kind === 'bicycle'), near = (o, d) => Math.hypot(o.x - p.x, o.z - p.z) < d;
  if (tool.kind === 'tree') {
    if (!(l < left - TREE_KERB_M || l > right + TREE_KERB_M)) return {why: 'Trees can only be planted on the footpath.'};
    // crowns may overlap a little, as on the map (placement.crown_overlap in config/model.json)
    const r = S.model.presets[tool.id].crown_diameter_m / 2, k = S.model.placement.crown_overlap;
    if (trees.some(o => near(o, (r + S.model.presets[o.preset].crown_diameter_m / 2) * k))) return {why: 'Too close to another tree: their crowns would overlap.'};
    return bikes.some(o => near(o, TREE_BICYCLE_M)) ? {why: 'A bicycle is in the way.'} : {p};
  }
  const veh = VEHICLES[tool.kind], [len, wid] = veh.size, name = tool.kind;
  if (veh.place === 'footpath') {
    if (!(l < left - KERB_GAP_M - wid / 2 || l > right + KERB_GAP_M + wid / 2)) return {why: `A ${name} can only go on the footpath.`};
    if (trees.some(o => near(o, TREE_BICYCLE_M))) return {why: 'A tree is in the way.'};
  } else if (!(l > left + KERB_GAP_M + wid / 2 && l < right - KERB_GAP_M - wid / 2)) {
    return {why: `A ${name} can only go on the road.`};
  }
  // vehicles keep a safe distance from every vehicle sharing their space (road or footpath)
  const clash = all.filter(o => isVehicle(o.kind) && VEHICLES[o.kind].place === veh.place).find(o => {
    const w = VEHICLES[o.kind];
    return Math.abs(along(o) - s) < (len + w.size[0]) / 2 + Math.max(veh.gap[0], w.gap[0]) &&
           Math.abs(lateral(o) - l) < (wid + w.size[1]) / 2 + Math.max(veh.gap[1], w.gap[1]);
  });
  return clash ? {why: `Too close to another ${clash.kind}: keep a safe distance.`} : {p};
}

// Street frame of a ground point: distance from the centre line (positive to the right) and along the street.
function lateral(p) {
  const yaw = S.view.street_bearing_deg * DEG - S.cam.bearing;
  return p.x * Math.cos(yaw) - p.z * Math.sin(yaw);
}

function along(p) {
  const yaw = S.view.street_bearing_deg * DEG - S.cam.bearing;
  return p.x * Math.sin(yaw) + p.z * Math.cos(yaw);
}

function onClick(pt) {
  // only the Remove tool takes objects away: the nearest one under the click
  if (S.tool === 'remove') {
    const hit = S.rects.filter(r => pt.u >= r.x0 && pt.u <= r.x1 && pt.v >= r.y0 && pt.v <= r.y1).sort((a, b) => a.depth - b.depth)[0];
    if (!hit) return hint('Click a tree trunk or a car to remove it.', true);
    S.items.splice(S.items.indexOf(hit.item), 1);
  } else {
    const {p, why} = spot(pt);
    if (!p) return hint(why, true);
    const tool = TOOLS.find(t => t.id === S.tool), {east, north} = S.cam.toEN(p);
    S.items.push({kind: tool.kind, preset: tool.kind === 'tree' ? tool.id : null, east: round2(east), north: round2(north), seed: (Math.random() * 1e9) | 0});
  }
  hint('');
  S.hover = null;
  saveItems();
  draw();
}

// A demonstration scene (config/street.json "demo"): trees, cars, the bus, a motorbike and bicycles in
// both views, given as [kind, preset, metres east of the centre line, metres north along the street];
// it replaces what is placed.
function demoScene() {
  const A = S.cfg.street_axis_bearing_deg * DEG, sa = Math.sin(A), ca = Math.cos(A);
  S.items = S.cfg.demo.items.map(([kind, preset, l, s], i) => ({kind, preset, east: round2(s * sa + l * ca), north: round2(s * ca - l * sa), seed: i}));
  saveItems();
  hint('Demo scene placed in both views: look north and south. Remove all clears it.');
  draw();
}

// The street's trees and cars in the current view's ground metres {x, z} (z < 0: behind the camera).
function viewObjects() {
  return S.items.map(item => ({...S.cam.fromEN(item.east, item.north), kind: item.kind, preset: item.preset, seed: item.seed, item}));
}

function hint(msg, error = false) {
  $('hint').textContent = msg || 'Trees and bicycles go on the footpath; cars, the bus and motorbikes on the road, with room between them. Use Remove to take one away.';
  $('hint').classList.toggle('err', error);
}

// ------------------------------------------------------------------ drawing

function draw() {
  cancelAnimationFrame(S.frame);
  S.frame = requestAnimationFrame(() => render());
}

function render(opts = {}) {
  const {ctx, img, cam} = S;
  if (!img) return;
  const W = img.naturalWidth, H = img.naturalHeight, sun = sunPosition();
  const minute = +$('time').value;
  $('timeLabel').textContent = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const alt = sun.altitude / DEG, from = ((sun.azimuth / DEG + 180) % 360 + 360) % 360;
  $('sun').textContent = alt > 0 ? `Sun ${alt.toFixed(0)}° high, from the ${compass(from)} (${from.toFixed(0)}°): tree shadows fall to the ${compass((from + 180) % 360)}.`
    : alt > -8 ? 'Dusk: the sun is just below the horizon, no shadows.' : 'Night: the sun is below the horizon, no shadows.';

  const objs = viewObjects().filter(o => o.z > 1).map(o => ({...o, depth: Math.hypot(o.x, o.z)}));
  if (S.hover && !opts.clean) {
    const t = TOOLS.find(x => x.id === S.tool);
    objs.push({kind: t.kind, preset: t.kind === 'tree' ? t.id : null, x: S.hover.x, z: S.hover.z, seed: 7, depth: Math.hypot(S.hover.x, S.hover.z), ghost: true});
  }
  for (const o of objs) if (o.kind !== 'tree') o.pose = vehiclePose(o);

  ctx.globalAlpha = 1;
  ctx.drawImage(img, 0, 0);
  ctx.save();
  ctx.clip(S.ground);
  for (const o of objs) groundMarks(o, sun);
  ctx.restore();

  S.rects = [];
  S.lights = [];
  // the stop sign takes its place among the objects by distance, so a tree behind it does not cover it
  const pole = S.view.stop && cam.toGround(...S.view.stop.pole), poleDepth = pole ? Math.hypot(pole.x, pole.z) : Infinity;
  let stopDrawn = false;
  for (const o of objs.sort((a, b) => b.depth - a.depth)) {
    if (!stopDrawn && o.depth < poleDepth) { busStop(); stopDrawn = true; }
    const r = drawObject(o);
    if (r && !o.ghost) S.rects.push({...r, depth: o.depth, item: o.item});
  }
  if (!stopDrawn) busStop();
  for (const fg of S.foreground) { ctx.save(); ctx.clip(fg); ctx.drawImage(img, 0, 0); ctx.restore(); }
  daylight(sun, W, H);

  if (S.hover && !opts.clean) {
    const p = cam.project(S.hover.x, 0, S.hover.z);
    label(`${Math.round(Math.hypot(S.hover.x, S.hover.z))} m`, p.u, p.v + 22);
  }
  if (S.debug) debugGrid();
  updateCount();
  showResult(sun);
}

// ------------------------------------------------------------------ bus stop
// The stop sign as at Etzelstraße (Heilbronn): a white panel with a round top on a pole at the
// shelter, standing just above its roof, with the H symbol, the stop's name on blue and the lines
// with their destinations (config/street.json "stop": per view the pole's ground point, the image
// height of the shelter roof there, and the lines). The size comes from the roof in the image, as
// the AI shelters are not always the size the camera calibration gives at that distance.

const SIGN = {width_m: 0.47, height_m: 1.0, bottom_m: 2.45};   // the panel, and its lower edge (the roof) above the ground
const SIGN_COLOURS = {blue: '#4482cb', teal: '#1f8a7c', yellow: '#eeb24a', red: '#b53047', grey: '#cfd3d6', ink: '#27324f'};

function busStop() {
  const stop = S.view.stop, cfg = S.cfg.stop;
  if (!stop || !cfg) return;
  const [u, v] = stop.pole, s = (v - stop.roof_y) / SIGN.bottom_m, {ctx} = S, top = SIGN.bottom_m + SIGN.height_m;
  const p = {u, v};
  ctx.save();
  ctx.fillStyle = '#5d6367';  // the pole, up behind the panel
  ctx.fillRect(p.u - 0.035 * s, p.v - (top - 0.1) * s, 0.07 * s, (top - 0.1) * s);
  // the panel is drawn in a 300 x 640 box (its width : height), scaled to its size there
  const k = (SIGN.width_m * s) / 300;
  ctx.translate(p.u - 150 * k, p.v - top * s);
  ctx.scale(k, k);
  stopSign(ctx, cfg.name_lines, stop.lines);
  ctx.restore();
}

// The panel in its own 300 x 640 box, from the photo of the sign.
function stopSign(ctx, nameLines, lines) {
  const W = 300, H = 640, C = SIGN_COLOURS, R = W / 2;
  const roundTop = (x0, y0, x1, y1) => {   // a rectangle with a semicircular top
    const r = (x1 - x0) / 2;
    ctx.beginPath();
    ctx.moveTo(x0, y1); ctx.lineTo(x0, y0 + r);
    ctx.arc(x0 + r, y0 + r, r, Math.PI, 0);
    ctx.lineTo(x1, y1); ctx.closePath();
  };
  const font = (px, weight = 700) => `${weight} ${px}px "DejaVu Sans", system-ui, sans-serif`;
  // white panel with a thin grey edge
  roundTop(0, 0, W, H);
  ctx.fillStyle = '#f4f4f1'; ctx.fill();
  ctx.strokeStyle = '#9aa0a4'; ctx.lineWidth = 3; ctx.stroke();
  // blue field following the round top, a white arch band inside its top, blue below
  const m = 28, blueEnd = 405;
  roundTop(m, m, W - m, blueEnd);
  ctx.fillStyle = C.blue; ctx.fill();
  ctx.save();
  roundTop(m + 8, m + 8, W - m - 8, blueEnd);
  ctx.clip();
  ctx.fillStyle = '#f4f4f1';
  ctx.fillRect(0, 0, W, 138);
  ctx.restore();
  // H symbol: yellow disc, teal ring and H, with a thin white edge
  const cx = R, cy = 165, r = 92;
  ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, 2 * Math.PI); ctx.fillStyle = '#f4f4f1'; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.fillStyle = C.teal; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, r - 17, 0, 2 * Math.PI); ctx.fillStyle = C.yellow; ctx.fill();
  ctx.fillStyle = C.teal;   // the H as bars, as on the sign
  ctx.fillRect(cx - 42, cy - 50, 22, 100);
  ctx.fillRect(cx + 20, cy - 50, 22, 100);
  ctx.fillRect(cx - 20, cy - 10, 40, 20);
  // stop name in white, on two lines as on the sign
  ctx.fillStyle = '#eef2f6';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = font(38);
  nameLines.forEach((t, i) => ctx.fillText(t, R, 300 + i * 52, W - 2 * m - 30));
  // lines: red number boxes, a small white marker, destinations in dark blue on grey
  const top = blueEnd + 6, row = 38;
  ctx.fillStyle = C.grey;
  ctx.fillRect(m + 4, top, W - 2 * m - 4, row * lines.length + 6);
  lines.forEach(([num, dest], i) => {
    const y = top + 3 + i * row;
    ctx.fillStyle = C.red;
    ctx.fillRect(m + 6, y, 52, row - 4);
    ctx.fillStyle = '#fff';
    ctx.fillRect(m + 61, y + 3, 10, row - 10);
    ctx.strokeStyle = C.blue; ctx.lineWidth = 2;
    ctx.strokeRect(m + 61, y + 3, 10, row - 10);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'right';
    ctx.font = font(26);
    ctx.fillText(num, m + 55, y + row / 2);
    ctx.fillStyle = C.ink;
    ctx.textAlign = 'left';
    ctx.font = font(21);
    ctx.fillText(dest, m + 80, y + row / 2, W - m - 88);
  });
  // fixing bolts at the bottom
  ctx.fillStyle = '#8a8f93';
  for (const x of [34, R - 30, R + 30, W - 34]) { ctx.beginPath(); ctx.arc(x, H - 26, 5, 0, 2 * Math.PI); ctx.fill(); }
}

// Contact shadows and sun shadows on the ground (drawn under every object).
function groundMarks(o, sun) {
  const {ctx, cam} = S, alpha = o.ghost ? 0.5 : 1;
  if (o.kind === 'tree') {
    const p = S.model.presets[o.preset];
    if ($('shadows').checked && sun.altitude > 0) {
      const {east, north} = cam.toEN(o);
      const e = NG.shadowEllipse({x: east, y: north, height_m: p.height_m, crown_diameter_m: p.crown_diameter_m}, sun, S.model);
      if (e) {
        const crown = NG.ellipseRing(e, 40).map(([x, y]) => cam.fromEN(x, y));
        const tip = cam.fromEN(e.cx - e.dir[0] * e.a * 0.6, e.cy - e.dir[1] * e.a * 0.6);
        const k = Math.min(1, Math.sin(sun.altitude) / Math.sin(30 * DEG));  // weaker at low sun
        fillGround(crown, `rgba(28, 34, 44, ${(0.45 + 0.25 * k) * alpha})`, 4, 'multiply');
        fillGround(quad(o, tip, 0.18), `rgba(28, 34, 44, ${(0.4 + 0.25 * k) * alpha})`, 2, 'multiply');
      }
    }
    fillGround(circle(o, p.crown_diameter_m * 0.42), `rgba(10, 14, 10, ${0.22 * alpha})`, 10);
    fillGround(circle(o, 0.45), `rgba(20, 20, 18, ${0.45 * alpha})`, 3);
  } else {
    const [len, wid] = VEHICLES[o.kind].size;
    const a = o.pose.heading, ax = Math.sin(a), ay = Math.cos(a);
    const c = cam.toEN(o), pts = [];
    for (const [s, l] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
      pts.push(cam.fromEN(c.east + ax * s * len / 2 + ay * l * wid / 2, c.north + ay * s * len / 2 - ax * l * wid / 2));
    }
    fillGround(pts, `rgba(0, 0, 0, ${0.5 * alpha})`, 4);
  }
}

function fillGround(pts, colour, blur, mode = 'source-over') {
  // points behind the camera are dropped, so a shadow reaching past it is still drawn in front
  const proj = pts.map(p => S.cam.project(p.x, 0, p.z)).filter(Boolean);
  if (proj.length < 3) return;
  const {ctx} = S;
  ctx.save();
  ctx.globalCompositeOperation = mode;
  ctx.filter = blur ? `blur(${Math.max(1, blur * proj[0].scale / 40).toFixed(1)}px)` : 'none';
  ctx.fillStyle = colour;
  ctx.beginPath();
  proj.forEach((p, i) => (i ? ctx.lineTo(p.u, p.v) : ctx.moveTo(p.u, p.v)));
  ctx.fill();
  ctx.restore();
}

const circle = (o, r, n = 28) => Array.from({length: n}, (_, i) => ({x: o.x + r * Math.cos((i / n) * 2 * Math.PI), z: o.z + r * Math.sin((i / n) * 2 * Math.PI)}));

// Thin ground strip from a to b (a trunk shadow), half width w.
function quad(a, b, w) {
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1, nx = (-dz / l) * w, nz = (dx / l) * w;
  return [{x: a.x + nx, z: a.z + nz}, {x: b.x + nx, z: b.z + nz}, {x: b.x - nx, z: b.z - nz}, {x: a.x - nx, z: a.z - nz}];
}

function drawObject(o) {
  if (VEHICLES[o.kind] && VEHICLES[o.kind].box && !o.face) return drawBox(o);
  const p = S.cam.project(o.x, 0, o.z);
  if (!p) return null;
  const sp = sprite(o);
  if (!sp) return null;
  const k = p.scale / sp.px_per_m, w = sp.img.naturalWidth * k, h = sp.img.naturalHeight * k;
  const x0 = p.u - sp.ground[0] * k, y0 = p.v - sp.ground[1] * k, {ctx} = S;
  const haze = Math.min(1, o.depth / 120);  // aerial perspective: paler and flatter with distance
  ctx.save();
  ctx.globalAlpha = o.ghost ? 0.55 : 1;
  ctx.filter = `contrast(${(1 - 0.35 * haze).toFixed(2)}) saturate(${(1 - 0.4 * haze).toFixed(2)}) brightness(${(1 + 0.25 * haze).toFixed(2)})`;
  ctx.imageSmoothingQuality = 'high';
  const mirrored = !!(o.pose && 'flip' in o.pose && o.pose.flip !== (sp.faces === 'left'));  // side and quarter views face right unless marked
  if (mirrored) {
    ctx.translate(p.u, 0); ctx.scale(-1, 1); ctx.translate(-p.u, 0);
  }
  ctx.drawImage(sp.img, x0, y0, w, h);
  ctx.restore();
  if (sp.display && !o.ghost) destination(o, sp.display, k, x0, y0, p.u, mirrored);
  if (isVehicle(o.kind) && !o.ghost) vehicleLights(o, p);
  if (o.kind !== 'tree') return {x0, y0, x1: x0 + w, y1: y0 + h};
  // a tree is picked by its trunk, so you can still plant behind a crown
  const half = Math.max(0.5 * p.scale, 8);
  return {x0: p.u - half, x1: p.u + half, y0: p.v - 2.5 * p.scale, y1: p.v + 0.4 * p.scale};
}

// A long vehicle as a box in perspective: its long side facing the camera, the side cut-out laid
// along the street in thin vertical strips (each at the size of its distance), and in front of it
// the end nearest the camera (rear when it drives away, front when it comes towards the camera).
function drawBox(o) {
  const {cam, ctx} = S, wid = VEHICLES[o.kind].size[1], a = o.pose.heading;
  const side = sprite({...o, pose: {side: 'side'}});
  if (!side) return null;
  const c = cam.toEN(o), dir = [Math.sin(a), Math.cos(a)], left = [-Math.cos(a), Math.sin(a)];
  const seesLeft = c.east * left[0] + c.north * left[1] < 0;          // the left side faces the camera
  const n = seesLeft ? left : [-left[0], -left[1]];
  const W = side.img.naturalWidth, L = W / side.px_per_m, Hm = side.ground[1] / side.px_per_m;
  const at = (along, across) => cam.fromEN(c.east + dir[0] * along + n[0] * across, c.north + dir[1] * along + n[1] * across);
  // the side cut-out shows the left side, front to the right unless marked; the right side is its mirror image
  const mirrored = !seesLeft, frontRight = (side.faces !== 'left') !== mirrored;
  const src = document.createElement('canvas');
  src.width = W; src.height = side.img.naturalHeight;
  const sc = src.getContext('2d');
  if (mirrored) { sc.translate(W, 0); sc.scale(-1, 1); }
  sc.drawImage(side.img, 0, 0);
  sc.setTransform(1, 0, 0, 1, 0, 0);
  if (side.display && !o.ghost) destination(o, side.display, 1, 0, 0, W / 2, mirrored, sc);
  const haze = Math.min(1, o.depth / 120);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  ctx.save();
  ctx.globalAlpha = o.ghost ? 0.55 : 1;
  ctx.filter = `contrast(${(1 - 0.35 * haze).toFixed(2)}) saturate(${(1 - 0.4 * haze).toFixed(2)}) brightness(${(1 + 0.25 * haze).toFixed(2)})`;
  ctx.imageSmoothingQuality = 'high';
  const edge = t => {   // image column t (0 left, 1 right) on the side: bottom and top on screen
    const g = at((frontRight ? t - 0.5 : 0.5 - t) * L, wid / 2);
    const b = cam.project(g.x, 0, g.z), u = cam.project(g.x, Hm, g.z);
    return b && u ? {u: b.u, bottom: b.v, top: u.v} : null;
  };
  // strips about 1.5 screen pixels wide (so the steps of the top and bottom edges stay below a
  // pixel), each the height of the side at its distance; a strip runs right to left on screen
  // when the side does, which mirrors it
  const first = edge(0), last = edge(1);
  const N = Math.min(800, Math.max(24, Math.ceil(Math.abs(((last || first || {u: 0}).u) - ((first || last || {u: 0}).u)) / 1.5)));
  const sw = W / N, sh = src.height;
  let prev = first;
  for (let i = 1; i <= N; i++) {
    const cur = i === N ? last : edge(i / N);
    if (prev && cur) {
      const l = Math.min(prev.u, cur.u), w = Math.abs(cur.u - prev.u) + 0.5;
      const top = (prev.top + cur.top) / 2, bottom = (prev.bottom + cur.bottom) / 2;
      if (cur.u >= prev.u) ctx.drawImage(src, (i - 1) * sw, 0, sw, sh, l, top, w, bottom - top);
      else { ctx.save(); ctx.translate(2 * l + w, 0); ctx.scale(-1, 1); ctx.drawImage(src, (i - 1) * sw, 0, sw, sh, l, top, w, bottom - top); ctx.restore(); }
      x0 = Math.min(x0, l); x1 = Math.max(x1, l + w); y0 = Math.min(y0, top); y1 = Math.max(y1, bottom);
    }
    prev = cur;
  }
  ctx.restore();
  // the near end, a flat end view at that end
  const away = c.east * dir[0] + c.north * dir[1] > 0;
  const e = at(away ? -L / 2 : L / 2, 0);
  const r = e.z > 1 ? drawObject({...o, ...e, face: true, depth: Math.hypot(e.x, e.z), pose: {heading: a, side: away ? 'rear' : 'front'}}) : null;
  if (r) { x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0); x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1); }
  return x0 < x1 ? {x0, y0, x1, y1} : null;
}

// ------------------------------------------------------------------ day and night
// The views are daytime images; the light of the chosen date and time is laid over them:
// warm low sun around sunrise and sunset, blue dusk, night once the sun is 8° below the horizon.

function nightLevel(sun) {
  const alt = sun.altitude / DEG, t = Math.min(1, Math.max(0, (4 - alt) / 12));  // 0 above 4°, 1 below −8°
  return t * t * (3 - 2 * t);
}

function daylight(sun, W, H) {
  const n = nightLevel(sun), alt = sun.altitude / DEG, {ctx} = S;
  const warm = Math.max(0, 1 - Math.abs(alt - 2) / 10) * (1 - n);  // golden hour around the horizon
  if (n < 0.01 && warm < 0.01) return;
  // multiply: white leaves the image as it is, the tint darkens and colours it
  const mix = (a, b, t) => a + (b - a) * t;
  const night = [36, 46, 84], gold = [255, 196, 140];
  const c = [0, 1, 2].map(i => Math.round(mix(mix(255, gold[i], warm), night[i], n)));
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = `rgb(${c})`;
  ctx.fillRect(0, 0, W, H);
  if (n > 0.3) {  // a darker sky than ground: deepen the upper part a little
    const g = ctx.createLinearGradient(0, 0, 0, S.view.horizon_y + 60);
    g.addColorStop(0, `rgba(10, 14, 34, ${0.55 * n})`);
    g.addColorStop(1, 'rgba(10, 14, 34, 0)');
    ctx.fillStyle = g;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillRect(0, 0, W, S.view.horizon_y + 60);
  }
  ctx.restore();
  // car lights shine on top of the darkness
  if (n < 0.15) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const l of S.lights) {
    // a small bright lamp with a soft halo
    const halo = l.r * 3, g = ctx.createRadialGradient(l.u, l.v, 0, l.u, l.v, halo);
    g.addColorStop(0, `rgba(${l.colour}, ${0.9 * n})`);
    g.addColorStop(0.12, `rgba(${l.colour}, ${0.7 * n})`);
    g.addColorStop(0.35, `rgba(${l.colour}, ${0.18 * n})`);
    g.addColorStop(1, `rgba(${l.colour}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(l.u, l.v, halo, 0, 2 * Math.PI); ctx.fill();
  }
  ctx.restore();
}

// Lamp positions of a vehicle on screen: headlights from the front, tail lights from behind or the side.
function vehicleLights(o, p) {
  const v = VEHICLES[o.kind], s = p.scale, side = o.pose.side, half = v.size[0] / 2;
  const front = '255, 244, 214', tail = '255, 40, 30', r = Math.max(2, (o.kind === 'bicycle' ? 0.08 : 0.14) * s);
  if (side === 'front') for (const [d, h] of v.front) S.lights.push({u: p.u + d * s, v: p.v - h * s, colour: front, r});
  else if (side === 'rear') for (const [d, h] of v.rear) S.lights.push({u: p.u + d * s, v: p.v - h * s, colour: tail, r: r * 0.8});
  else if (side.endsWith('-quarter')) {  // the lamps at the near end, a little towards where it points, closer together
    const dir = o.pose.flip ? -1 : 1, rear = side === 'rear-quarter', shift = (rear ? -1 : 1) * dir * 0.3 * half;
    for (const [d, h] of rear ? v.rear : v.front) S.lights.push({u: p.u + (shift + 0.6 * d) * s, v: p.v - h * s, colour: rear ? tail : front, r: rear ? r * 0.8 : r});
  } else {
    const dir = o.pose.flip ? -1 : 1;
    S.lights.push({u: p.u + dir * 0.96 * half * s, v: p.v - v.front[0][1] * s, colour: front, r});
    S.lights.push({u: p.u - dir * 0.97 * half * s, v: p.v - v.rear[0][1] * s, colour: tail, r: r * 0.7});
  }
  if (o.kind === 'bus') {  // the lit destination display with the line number
    const at = side === 'side' ? (o.pose.flip ? -1 : 1) * 0.6 * half : 0;
    S.lights.push({u: p.u + at * s, v: p.v - 2.85 * s, colour: '255, 150, 40', r: r * 1.3});
  }
}

// The bus's destination display, written in by the app (readable, unlike AI lettering): line and
// destination of the direction it drives (config/street.json "bus"), as LED text on dark glass.
function destination(o, [bx0, by0, bx1, by1], k, x0, y0, u, mirrored, ctx = S.ctx) {
  const bus = S.cfg.bus, A = S.cfg.street_axis_bearing_deg * DEG;
  const north = Math.cos(o.pose.heading - A) > 0, words = bus.towards[north ? 'north' : 'south'].split(' ');
  let x = x0 + bx0 * k;
  const y = y0 + by0 * k, w = (bx1 - bx0) * k, h = (by1 - by0) * k;
  if (mirrored) x = 2 * u - x - w;
  if (h < 5) return;  // too far away to read
  const num = Math.min(h * 0.9, w * 0.22), pad = h * 0.08;
  ctx.save();
  ctx.fillStyle = '#121212';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#ffae1a';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${num.toFixed(1)}px "DejaVu Sans", system-ui, sans-serif`;
  ctx.fillText(bus.line, x + pad, y + h / 2 + num * 0.04);
  const tx = x + pad * 2 + ctx.measureText(bus.line).width, tw = x + w - pad - tx;
  // destination on one or two lines, as large as fits
  const lines = words.length > 1 ? [words.slice(0, -1).join(' '), words[words.length - 1]] : words;
  let size = (h - 2 * pad) / lines.length * 0.92;
  ctx.font = `600 ${size.toFixed(1)}px "DejaVu Sans", system-ui, sans-serif`;
  const widest = Math.max(...lines.map(l => ctx.measureText(l).width));
  if (widest > tw) { size *= tw / widest; ctx.font = `600 ${size.toFixed(1)}px "DejaVu Sans", system-ui, sans-serif`; }
  lines.forEach((l, i) => ctx.fillText(l, tx, y + h / 2 + (i - (lines.length - 1) / 2) * size * 1.05));
  ctx.restore();
}

// Vehicles drive on the right: east of the centre line towards the street axis bearing, west of it the other way.
// Seen from the camera that is a rear, front or side view; seen at an angle (off to the side of the
// camera, on the footpath or near it) a three-quarter view (rear-quarter, front-quarter) where there
// are cut-outs for them: cars, motorbikes and bicycles. The bus is drawn in perspective (drawBox).
function vehiclePose(o) {
  const {cam} = S, A = S.cfg.street_axis_bearing_deg * DEG;
  const {east, north} = cam.toEN(o), lateral = east * Math.cos(A) - north * Math.sin(A);
  const heading = lateral > 0 ? A : A + Math.PI;  // the camera stands on the centre line
  const r = Math.hypot(east, north), along = (east * Math.sin(heading) + north * Math.cos(heading)) / r;
  const quarters = Object.values(S.sprites).some(sp => sp.kind === o.kind && sp.side === 'rear-quarter');
  const end = along > 0 ? 'rear' : 'front';
  if (Math.abs(along) > (quarters ? 0.92 : 0.72)) return {heading, side: end};   // within 23° (quarters) or 44° of head-on
  // which way it points on screen: side and quarter views face right, mirrored to face left
  const ahead = cam.fromEN(east + Math.sin(heading), north + Math.cos(heading));
  const p0 = cam.project(o.x, 0, o.z), p1 = cam.project(ahead.x, 0, ahead.z), flip = !!(p0 && p1 && p1.u < p0.u);
  return {heading, side: quarters && Math.abs(along) > 0.38 ? `${end}-quarter` : 'side', flip};
}

function label(text, u, v) {
  const {ctx} = S;
  ctx.font = '600 22px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 16;
  ctx.fillStyle = 'rgba(29, 35, 41, 0.75)';
  ctx.beginPath(); ctx.roundRect(u - w / 2, v - 16, w, 30, 6); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(text, u, v + 7);
  ctx.textAlign = 'start';
}

function updateCount() {
  const n = k => S.items.filter(o => o.kind === k).length, ahead = viewObjects().filter(o => o.z > 1).length;
  const plural = (c, w) => `${c} ${w}${c === 1 ? '' : 's'}`, total = S.items.length;
  const parts = ['tree', ...Object.keys(VEHICLES)].filter(k => n(k)).map(k => plural(n(k), k === 'bus' ? 'bus' : k));
  $('count').textContent = !total ? 'Nothing placed yet. Both views share one street.'
    : `On the street: ${parts.join(', ').replace(/buss\b/, 'buses')}` +
      (ahead === total ? ', all in this view.' : `; ${ahead} in this view, ${total - ahead} behind you (in the other view).`);
}

// Ground lines parallel to the street every metre (magenta every 5 m) and across it every 5 m,
// to check the calibration against kerbs and lane markings (street.html?debug).
function debugGrid() {
  const {ctx, cam} = S, yaw = S.view.street_bearing_deg * DEG - cam.bearing;
  const toCam = (l, s) => ({x: l * Math.cos(yaw) + s * Math.sin(yaw), z: -l * Math.sin(yaw) + s * Math.cos(yaw)});
  ctx.lineWidth = 1.5;
  const line = (a, b, colour) => {
    const pts = [];
    for (let t = 0; t <= 1.0001; t += 0.02) { const q = toCam(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t); if (q.z > 0.5) pts.push(cam.project(q.x, 0, q.z)); }
    ctx.strokeStyle = colour;
    ctx.beginPath();
    pts.filter(Boolean).forEach((p, i) => (i ? ctx.lineTo(p.u, p.v) : ctx.moveTo(p.u, p.v)));
    ctx.stroke();
  };
  for (let l = -20; l <= 20; l++) line([l, -30], [l, 120], l % 5 ? 'rgba(0,255,255,.45)' : 'rgba(255,0,255,.9)');
  for (let s = -30; s <= 120; s += 5) line([-20, s], [20, s], 'rgba(255,255,0,.6)');
  ctx.strokeStyle = '#f00';
  ctx.beginPath(); ctx.moveTo(0, S.view.horizon_y); ctx.lineTo(S.img.naturalWidth, S.view.horizon_y); ctx.stroke();
}

// ------------------------------------------------------------------ before / after
// As the map's scenario panel: means over the street between its building fronts (area_lateral_m), area_along_m
// ahead in both directions, without and with everything placed on the street, so both views
// show the same numbers. All numbers in config/model.json ("street_view"):
//   temperature: the map's tree model (model.js) + vehicle waste heat over the roadway
//                (measures.traffic.C_per_W_m2 °C per W/m²)
//   NO2, PM2.5:  background + what the traffic station measures from its traffic, scaled by
//                trips × emission factor of each vehicle type against its fleet, × the tree effect
//                on a street's concentration ('pollution': canyon higher, open street lower)

function showResult(sun) {
  const placed = S.items;
  const key = JSON.stringify([placed.map(o => [o.kind, o.preset, o.east, o.north]), $('date').value, $('time').value]);
  if (S.resultKey === key) return;
  S.resultKey = key;
  $('resultPanel').hidden = !placed.length;  // only once something is placed
  if (!placed.length) return;
  const p = S.model.street_view, ref = p.reference, [w0, w1] = p.area_lateral_m, [s0, s1] = p.area_along_m, cell = 1;
  const A = S.cfg.street_axis_bearing_deg * DEG, sa = Math.sin(A), ca = Math.cos(A);
  const toEN = (l, s) => ({east: s * sa + l * ca, north: s * ca - l * sa});
  const trees = placed.filter(o => o.kind === 'tree').map(o => {
    const t = S.model.presets[o.preset];
    return {x: o.east, y: o.north, height_m: t.height_m, crown_diameter_m: t.crown_diameter_m};
  });
  const shadows = trees.map(t => NG.shadowEllipse(t, sun, S.model));
  let n = 0, dT = 0, shaded = 0, covered = 0;
  for (const dir of [1, -1]) {
    for (let a0 = s0 + cell / 2; a0 < s1; a0 += cell) {
      for (let l = w0 + cell / 2; l < w1; l += cell) {
        const {east, north} = toEN(l, dir * a0);
        n++;
        if (!trees.length) continue;
        const e = NG.treeEffect(east, north, trees, shadows, sun, S.model);
        dT += e.dT;
        if (e.shade >= 1) shaded += cell * cell;   // inside a crown's shadow (not its soft edge)
        if (trees.some(t => Math.hypot(east - t.x, north - t.y) < t.crown_diameter_m / 2)) covered++;
      }
    }
  }
  // traffic: each vehicle placed = trips_per_day trips of its type
  const kinds = Object.keys(VEHICLES).filter(k => placed.some(o => o.kind === k)).map(k => {
    const v = p.vehicles[k], count = placed.filter(o => o.kind === k).length, trips = count * p.trips_per_day;
    return {k, v, count, people: trips * v.people,
            no2: (ref.no2_ugm3 * trips * v.nox_g_per_km) / (ref.vehicles_per_day * ref.nox_g_per_km),
            pm25: (ref.pm25_ugm3 * trips * v.pm25_g_per_km) / (ref.vehicles_per_day * ref.pm25_g_per_km),
            // waste heat in W per m² of roadway, averaged over the day
            heat: (trips / 86400) * v.energy_MJ_per_km * 1000 / p.roadway_width_m};
  });
  const sum = f => kinds.reduce((t, x) => t + x[f], 0);
  // trees change the street's concentration by their crown cover (street canyon: up, open street: down)
  const cover = n ? covered / n : 0, pol = S.model.pollution;
  const treeFactor = 1 + (p.canyon ? pol.canyon_increase_pct : -pol.deposition_pct_full_cover) / 100 * cover;
  const kPerW = S.model.measures.traffic.C_per_W_m2;
  const treesC = dT / n, trafficC = kPerW * sum('heat');
  const before = p.air_temperature_C, after = before + treesC + trafficC;
  const no2 = [p.no2_background_ugm3, (p.no2_background_ugm3 + sum('no2')) * treeFactor];
  const pm = [p.pm25_background_ugm3, (p.pm25_background_ugm3 + sum('pm25')) * treeFactor];
  const count = k => placed.filter(o => o.kind === k).length, plural = (c, w) => `${c} ${w}${c === 1 ? '' : w === 'bus' ? 'es' : 's'}`;
  const nVeh = placed.filter(o => isVehicle(o.kind)).length;
  const fmt = (x, d = 2) => (Math.abs(x) < 0.005 && d === 2 ? '±0.00' : signed(x, d));
  const rows = [
    ['head', `Temperature, ${plural(count('tree'), 'tree')}, ${plural(nVeh, 'vehicle')}`],
    ['Mean before', `${before.toFixed(1)} °C`],
    ['Trees', `${fmt(treesC, 1)} °C`],
    ['Vehicle heat', `${fmt(trafficC)} °C`],
    ['Mean after', `${after.toFixed(1)} °C`],
    ['Change', `${Math.abs(after - before) < 0.1 ? fmt(after - before) : signed(after - before, 1)} °C`, 'big'],
    ['Shaded', `${Math.round(shaded).toLocaleString('en')} of ${Math.round(n * cell * cell).toLocaleString('en')} m²`],
    ['head', 'Air pollution'],
    ['NO₂ before', `${no2[0].toFixed(1)} µg/m³`],
    ['NO₂ after', `${no2[1].toFixed(1)} µg/m³`],
    ['Change', `${fmt(no2[1] - no2[0])} µg/m³`, no2[1] > no2[0] + 0.005 ? 'big up' : 'big'],
    ['PM2.5 before', `${pm[0].toFixed(1)} µg/m³`],
    ['PM2.5 after', `${pm[1].toFixed(2)} µg/m³`],
    ['Change', `${fmt(pm[1] - pm[0])} µg/m³`, pm[1] > pm[0] + 0.005 ? 'up' : ''],
  ];
  if (trees.length) rows.push(['Trees on pollution', `× ${treeFactor.toFixed(3)}`]);
  let html = rows.map(([k, v, cls]) => k === 'head' ? `<dt class="head">${v}</dt>` : `<dt>${k}</dt><dd class="${cls || ''}">${v}</dd>`).join('');
  if (kinds.length) {
    // who adds what, per vehicle type and per person carried
    html += `<table class="mix"><tr><th></th><th>people a day</th><th>NO₂ µg/m³</th><th>heat °C</th><th>NO₂ per 1,000 people</th></tr>` +
      kinds.map(x => `<tr><td>${plural(x.count, x.k)}</td><td>${Math.round(x.people).toLocaleString('en')}</td>` +
        `<td>${fmt(x.no2)}</td><td>${fmt(kPerW * x.heat, 3)}</td><td>${(1000 * x.no2 / x.people).toFixed(2)}</td></tr>`).join('') + '</table>';
    // the point of it: a bus carries many people, so per person it adds far less than cars
    const car = kinds.find(x => x.k === 'car'), bus = kinds.find(x => x.k === 'bus');
    if (car && bus) {
      const r = (a, b) => (a / car.people) / (b / bus.people);
      html += `<p class="note">Per person carried, a car adds ${r(car.no2, bus.no2).toFixed(0)}× the NO₂ and ` +
        `${r(car.heat, bus.heat).toFixed(0)}× the heat of the bus. ${plural(car.count, 'car')} add ${car.no2 > bus.no2 ? 'more' : 'less'} NO₂ ` +
        `than ${plural(bus.count, 'bus')} (${fmt(car.no2)} against ${fmt(bus.no2)} µg/m³) but carry ${Math.round(car.people).toLocaleString('en')} people a day, ` +
        `the bus ${Math.round(bus.people).toLocaleString('en')}. Bicycles add none.</p>`;
    }
  }
  $('result').innerHTML = html +
    `<dt class="muted" style="grid-column:1/-1">The whole street in both views, between the building fronts (${-w0} m west and ${w1} m east of the centre line), ${s0}–${s1} m both ways. ` +
    `Each vehicle placed stands for ${p.trips_per_day} trips a day. Traffic scaled from Heilbronn's traffic station (NO₂ +${ref.no2_ugm3} µg/m³ ` +
    `from about ${ref.vehicles_per_day.toLocaleString('en')} vehicles a day) by each type's emission factor; vehicle heat as on the map; ` +
    `${p.canyon ? 'in a street canyon, trees slightly raise pollution' : 'trees remove a little pollution'}.</dt>`;
}

const signed = (v, digits) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(digits);

// ------------------------------------------------------------------ sprites
// Realistic cut-outs from scripts/make_sprites.py: trees per size, vehicles from behind, the front and
// the side, and (except the bus) three-quarter (facing right, or left if marked "faces"). The object's
// seed picks one of the variants.

function sprite(o) {
  const ids = Object.keys(S.sprites).filter(id => {
    const sp = S.sprites[id];
    return o.kind === 'tree' ? sp.kind === 'tree' && sp.preset === o.preset : sp.kind === o.kind && sp.side === o.pose.side;
  }).sort();
  return ids.length ? S.sprites[ids[o.seed % ids.length]] : null;
}

// ------------------------------------------------------------------ map hand-off, saving

// The street's trees go to the map tool (app.js reads them and plants them "by hand").
function toMap() {
  const trees = [], presets = {}, v = S.view, kx = 111320 * Math.cos(v.lat * DEG);
  for (const o of S.items) {
    if (o.kind !== 'tree') continue;
    trees.push({lon: v.lon + o.east / kx, lat: v.lat + o.north / 111320});
    presets[o.preset] = (presets[o.preset] || 0) + 1;
  }
  if (!trees.length) return ($('mapNote').textContent = 'Place a tree first.');
  const preset = Object.entries(presets).sort((a, b) => b[1] - a[1])[0][0];
  const at = [trees.reduce((s, t) => s + t.lon, 0) / trees.length, trees.reduce((s, t) => s + t.lat, 0) / trees.length];
  try {
    localStorage.setItem(HANDOFF_KEY, JSON.stringify({street: S.cfg.street, trees, preset, at, date: $('date').value, time: +$('time').value}));
  } catch {
    return ($('mapNote').textContent = 'The browser does not allow handing the trees over (storage blocked).');
  }
  location.href = 'index.html?from=street';
}

function saveImage() {
  render({clean: true});
  $('photo').toBlob(b => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `${S.cfg.street}-${S.view.id}.png`.toLowerCase().replace(/ß/g, 'ss').replace(/[^a-z0-9.-]+/g, '-');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
}

function loadItems() {
  try { const items = JSON.parse(localStorage.getItem(STORE_KEY)); return Array.isArray(items) ? items : []; } catch { return []; }
}

function saveItems() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S.items)); } catch { /* not persisted, still works */ }
}

// ------------------------------------------------------------------ helpers

function sunPosition() {
  const v = S.view, p = SunCalc.getPosition(zonedDate($('date').value, +$('time').value, 'Europe/Berlin'), v.lat, v.lon);
  return {altitude: p.altitude, azimuth: p.azimuth, bearing: p.azimuth + Math.PI};  // SunCalc azimuth is from south
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

function path(pts) {
  const p = new Path2D();
  pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
  p.closePath();
  return p;
}

function loadImage(src) {
  const im = new Image();
  im.src = src;
  return im.decode().then(() => im);
}

const round2 = x => Math.round(x * 100) / 100;
const compass = deg => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
const getJSON = async url => (await fetch(url, {cache: 'no-store'})).json();

main().catch(e => { $('hint').textContent = e.message; $('hint').classList.add('err'); });
