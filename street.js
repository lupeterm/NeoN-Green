'use strict';
// Street view: place trees and cars into views of a street from the centre of the road.
// The views are AI images (scripts/centre_view.py), the trees and cars realistic cut-outs
// (scripts/make_sprites.py). Camera model, ground mapping and drawing here; tree shadows from
// model.js; views and their calibration in config/street.json ("centre_views").

const HANDOFF_KEY = 'ng-street-handoff';   // read by app.js
const STORE_KEY = 'ng-street-objects-centre';
const SPRITES = 'data/street/sprites/sprites.json';
const MIN_DISTANCE_M = 2;
const TREE_KERB_M = 0.5;   // trunk at least this far behind the kerb, on the footpath
const CAR_KERB_M = 1.1;    // car centre at least this far inside the kerb (half a car's width plus a little)
const CAR_SIZE_M = [4.4, 1.8];   // length along the street, width
const CAR_GAP_M = [1.0, 0.5];    // safety gap to the next car: in front and behind, beside
const TOOLS = [
  {id: 'small', label: 'Small tree', kind: 'tree'},
  {id: 'medium', label: 'Medium tree', kind: 'tree'},
  {id: 'large', label: 'Large tree', kind: 'tree'},
  {id: 'car', label: 'Car', kind: 'car'},
  {id: 'remove', label: 'Remove', kind: null},
];

const $ = id => document.getElementById(id);
const DEG = Math.PI / 180;
const S = {
  cfg: null, model: null,
  view: null, cam: null, img: null, imgs: {},
  objects: {},           // view id -> [{kind, preset, x, z, seed}] in camera ground metres
  tool: 'medium', hover: null, rects: [], sprites: {},  // sprite id -> {img, ground, px_per_m, ...}
  ground: null, foreground: [], frame: 0, debug: new URLSearchParams(location.search).has('debug'),
};

async function main() {
  let sprites;
  [S.cfg, S.model, sprites] = await Promise.all([getJSON('config/street.json'), getJSON('config/model.json'), getJSON(SPRITES)]);
  S.views = S.cfg.centre_views;
  await Promise.all(Object.entries(sprites).map(async ([id, sp]) => { S.sprites[id] = {...sp, img: await loadImage(sp.image)}; }));
  S.ctx = $('photo').getContext('2d');
  S.objects = loadObjects();
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
  $('clear').onclick = () => { S.objects[S.view.id] = []; saveObjects(); draw(); };
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
  S.objects[id] ||= [];
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
  if (S.tool === 'remove') return {why: 'Click a tree trunk or a car to remove it.'};
  const p = S.ctx.isPointInPath(S.ground, u, v) && S.cam.toGround(u, v);
  if (!p || Math.hypot(p.x, p.z) < MIN_DISTANCE_M || Math.hypot(p.x, p.z) > S.cfg.max_distance_m) {
    return {why: `Click the footpath or the road, up to ${S.cfg.max_distance_m} m away.`};
  }
  const tool = TOOLS.find(t => t.id === S.tool), l = lateral(p), {left, right} = S.kerb;
  const others = S.objects[S.view.id].filter(o => o.kind === tool.kind);
  if (tool.kind === 'tree') {
    if (!(l < left - TREE_KERB_M || l > right + TREE_KERB_M)) return {why: 'Trees can only be planted on the footpath.'};
    // crowns may overlap a little, as on the map (placement.crown_overlap in config/model.json)
    const r = S.model.presets[tool.id].crown_diameter_m / 2, k = S.model.placement.crown_overlap;
    const near = others.find(o => Math.hypot(o.x - p.x, o.z - p.z) < (r + S.model.presets[o.preset].crown_diameter_m / 2) * k);
    return near ? {why: 'Too close to another tree: their crowns would overlap.'} : {p};
  }
  if (!(l > left + CAR_KERB_M && l < right - CAR_KERB_M)) return {why: 'Cars can only be placed on the road.'};
  const s = along(p), [len, wid] = CAR_SIZE_M, [gapL, gapW] = CAR_GAP_M;
  const near = others.find(o => Math.abs(along(o) - s) < len + gapL && Math.abs(lateral(o) - l) < wid + gapW);
  return near ? {why: 'Too close to another car: keep a safe distance.'} : {p};
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
  const list = S.objects[S.view.id];
  // only the Remove tool takes objects away: the nearest one under the click
  if (S.tool === 'remove') {
    const hit = S.rects.filter(r => pt.u >= r.x0 && pt.u <= r.x1 && pt.v >= r.y0 && pt.v <= r.y1).sort((a, b) => a.depth - b.depth)[0];
    if (!hit) return hint('Click a tree trunk or a car to remove it.', true);
    list.splice(list.indexOf(hit.obj), 1);
  } else {
    const {p, why} = spot(pt);
    if (!p) return hint(why, true);
    const tool = TOOLS.find(t => t.id === S.tool);
    list.push({kind: tool.kind, preset: tool.kind === 'tree' ? tool.id : null, x: round2(p.x), z: round2(p.z), seed: (Math.random() * 1e9) | 0});
  }
  hint('');
  S.hover = null;
  saveObjects();
  draw();
}

function hint(msg, error = false) {
  $('hint').textContent = msg || 'Trees go on the footpath, cars on the road, with room between them. Use Remove to take one away.';
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
                                 : 'The sun is below the horizon: no shadows.';

  const objs = S.objects[S.view.id].map(o => ({...o, depth: Math.hypot(o.x, o.z)}));
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
  for (const o of objs.sort((a, b) => b.depth - a.depth)) {
    const r = drawObject(o);
    if (r && !o.ghost) S.rects.push({...r, depth: o.depth, obj: S.objects[S.view.id].find(x => x.seed === o.seed && x.x === o.x && x.z === o.z)});
  }
  for (const fg of S.foreground) { ctx.save(); ctx.clip(fg); ctx.drawImage(img, 0, 0); ctx.restore(); }

  if (S.hover && !opts.clean) {
    const p = cam.project(S.hover.x, 0, S.hover.z);
    label(`${Math.round(Math.hypot(S.hover.x, S.hover.z))} m`, p.u, p.v + 22);
  }
  if (S.debug) debugGrid();
  updateCount();
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
    const [len, wid] = [4.4, 1.8];
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
  if (o.pose && o.pose.flip) {
    ctx.translate(p.u, 0); ctx.scale(-1, 1); ctx.translate(-p.u, 0);
  }
  ctx.drawImage(sp.img, x0, y0, w, h);
  ctx.restore();
  if (o.kind !== 'tree') return {x0, y0, x1: x0 + w, y1: y0 + h};
  // a tree is picked by its trunk, so you can still plant behind a crown
  const half = Math.max(0.5 * p.scale, 8);
  return {x0: p.u - half, x1: p.u + half, y0: p.v - 2.5 * p.scale, y1: p.v + 0.4 * p.scale};
}

// Vehicles drive on the right: east of the centre line towards the street axis bearing, west of it the other way.
// Seen from the camera that is a rear, front or side view.
function vehiclePose(o) {
  const {cam} = S, A = S.cfg.street_axis_bearing_deg * DEG;
  const {east, north} = cam.toEN(o), lateral = east * Math.cos(A) - north * Math.sin(A);
  const heading = lateral > 0 ? A : A + Math.PI;  // the camera stands on the centre line
  const r = Math.hypot(east, north), along = (east * Math.sin(heading) + north * Math.cos(heading)) / r;
  if (along > 0.72) return {heading, side: 'rear'};
  if (along < -0.72) return {heading, side: 'front'};
  const ahead = cam.fromEN(east + Math.sin(heading), north + Math.cos(heading));
  const p0 = cam.project(o.x, 0, o.z), p1 = cam.project(ahead.x, 0, ahead.z);
  return {heading, side: 'side', flip: !!(p0 && p1 && p1.u < p0.u)};
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
  const list = S.objects[S.view.id], n = k => list.filter(o => o.kind === k).length;
  const plural = (c, w) => `${c} ${w}${c === 1 ? '' : 's'}`;
  $('count').textContent = `In this view: ${plural(n('tree'), 'tree')}, ${plural(n('car'), 'car')}.`;
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

// ------------------------------------------------------------------ sprites
// Realistic cut-outs from scripts/make_sprites.py: trees per size, cars from behind, the front and
// the side (facing right). The object's seed picks one of the variants.

function sprite(o) {
  const ids = Object.keys(S.sprites).filter(id => {
    const sp = S.sprites[id];
    return o.kind === 'tree' ? sp.kind === 'tree' && sp.preset === o.preset : sp.kind === 'car' && sp.side === o.pose.side;
  }).sort();
  return ids.length ? S.sprites[ids[o.seed % ids.length]] : null;
}

// ------------------------------------------------------------------ map hand-off, saving

// Trees from all views go to the map tool (app.js reads them and plants them "by hand").
function toMap() {
  const trees = [], presets = {};
  for (const v of S.views) {
    const cam = camera(v, S.img.naturalWidth, S.img.naturalHeight);
    for (const o of S.objects[v.id] || []) {
      if (o.kind !== 'tree') continue;
      const [lon, lat] = cam.toLL(o);
      trees.push({lon, lat});
      presets[o.preset] = (presets[o.preset] || 0) + 1;
    }
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

function loadObjects() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}

function saveObjects() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S.objects)); } catch { /* not persisted, still works */ }
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
