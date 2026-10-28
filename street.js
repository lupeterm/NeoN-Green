'use strict';
// Street view: place trees and vehicles into calibrated photos of a street.
// Camera model, ground mapping and drawing here; tree shadows from model.js; views in config/street.json.

const HANDOFF_KEY = 'ng-street-handoff';   // read by app.js
const STORE_KEY = 'ng-street-objects';
const PX_PER_M = 48;                       // sprite resolution (vehicles)
const TREE_PX_PER_M = 72;                  // trees are seen larger, close up
const MIN_DISTANCE_M = 2;
const TOOLS = [
  {id: 'small', label: 'Small tree', kind: 'tree'},
  {id: 'medium', label: 'Medium tree', kind: 'tree'},
  {id: 'large', label: 'Large tree', kind: 'tree'},
  {id: 'car', label: 'Car', kind: 'car'},
  {id: 'bike', label: 'Bike', kind: 'bike'},
  {id: 'remove', label: 'Remove', kind: null},
];
const CAR_COLOURS = ['#e9ecef', '#adb5bd', '#25282c', '#1c3d6e', '#8b1e1e', '#5c636a', '#2b5d34', '#d9d2c3'];
const JACKETS = ['#c92a2a', '#1971c2', '#2f9e44', '#f08c00', '#495057', '#862e9c'];

const $ = id => document.getElementById(id);
const DEG = Math.PI / 180;
const S = {
  cfg: null, model: null,
  view: null, cam: null, img: null, imgs: {},
  objects: {},           // view id -> [{kind, preset, x, z, seed}] in camera ground metres
  tool: 'medium', hover: null, rects: [], sprites: new Map(),
  ground: null, foreground: [], frame: 0, debug: new URLSearchParams(location.search).has('debug'),
};

async function main() {
  [S.cfg, S.model] = await Promise.all([getJSON('config/street.json'), getJSON('config/model.json')]);
  S.ctx = $('photo').getContext('2d');
  S.objects = loadObjects();
  setupUi();
  const q = new URLSearchParams(location.search), wanted = q.get('view');
  await showView((S.cfg.views.find(v => v.id === wanted) || S.cfg.views[0]).id);
  if (q.get('redesign')) showRedesign(q.get('redesign'));
}

// ------------------------------------------------------------------ camera
// Pinhole camera at height h, no roll, pitched down so the horizon sits at horizon_y.
// Camera frame: x right, z forward (level), metres; ground points are {x, z}.

function camera(v, W, H) {
  const f = (S.cfg.focal_35mm / 43.27) * Math.hypot(W, H);  // 35 mm equivalent refers to the 43.27 mm diagonal
  const cx = W / 2, cy = H / 2, h = S.cfg.camera_height_m;
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
  for (const v of S.cfg.views) {
    const b = document.createElement('button');
    b.title = v.label;
    b.dataset.id = v.id;
    b.style.backgroundImage = `url(${v.image})`;
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
  for (const id of ['date', 'time', 'shadows', 'split']) $(id).oninput = draw;
  $('clear').onclick = () => { S.objects[S.view.id] = []; saveObjects(); draw(); };
  $('save').onclick = saveImage;
  $('toMap').onclick = toMap;
  for (const r of S.cfg.redesigns || []) {
    const b = document.createElement('button');
    b.textContent = r.label;
    b.dataset.id = r.id;
    b.onclick = () => showRedesign(r.id);
    $('redesigns').append(b);
  }

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
  const v = S.cfg.views.find(x => x.id === id);
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
  S.foreground = v.foreground.map(path);
  S.objects[id] ||= [];
  $('photo').width = W;
  $('photo').height = H;
  for (const b of $('views').children) b.classList.toggle('on', b.dataset.id === id);
  $('viewLabel').textContent = v.label;
  showRedesign(null);
  draw();
}

function imagePoint(e) {
  const c = $('photo'), r = c.getBoundingClientRect();
  return {u: ((e.clientX - r.left) * c.width) / r.width, v: ((e.clientY - r.top) * c.height) / r.height};
}

// Ground point under an image point if something can be placed there, else null.
function placeable({u, v}) {
  if (S.tool === 'remove' || !S.ctx.isPointInPath(S.ground, u, v)) return null;
  const p = S.cam.toGround(u, v);
  if (!p || Math.hypot(p.x, p.z) < MIN_DISTANCE_M || Math.hypot(p.x, p.z) > S.cfg.max_distance_m) return null;
  return p;
}

function onClick(pt) {
  const list = S.objects[S.view.id];
  // the nearest object under the click is removed, whatever the tool
  const hit = S.rects.filter(r => pt.u >= r.x0 && pt.u <= r.x1 && pt.v >= r.y0 && pt.v <= r.y1).sort((a, b) => a.depth - b.depth)[0];
  if (hit) {
    list.splice(list.indexOf(hit.obj), 1);
  } else {
    const p = placeable(pt);
    if (!p) return hint(S.tool === 'remove' ? 'Click an object you placed to remove it.' : 'Click the pavement or the road, up to ' + S.cfg.max_distance_m + ' m away.', true);
    const tool = TOOLS.find(t => t.id === S.tool);
    list.push({kind: tool.kind, preset: tool.kind === 'tree' ? tool.id : null, x: round2(p.x), z: round2(p.z), seed: (Math.random() * 1e9) | 0});
  }
  hint('');
  S.hover = null;
  saveObjects();
  draw();
}

function hint(msg, error = false) {
  $('hint').textContent = msg || 'Click the pavement or road to place, click an object to remove it.';
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
  const litRight = sun.altitude > 0 && Math.sin(sun.bearing - cam.bearing) > 0;
  for (const o of objs.sort((a, b) => b.depth - a.depth)) {
    const r = drawObject(o, litRight);
    if (r && !o.ghost) S.rects.push({...r, depth: o.depth, obj: S.objects[S.view.id].find(x => x.seed === o.seed && x.x === o.x && x.z === o.z)});
  }
  for (const fg of S.foreground) { ctx.save(); ctx.clip(fg); ctx.drawImage(img, 0, 0); ctx.restore(); }

  if (S.hover && !opts.clean) {
    const p = cam.project(S.hover.x, 0, S.hover.z);
    label(`${Math.round(Math.hypot(S.hover.x, S.hover.z))} m`, p.u, p.v + 22);
  }
  drawSplit(W, H);
  if (S.debug) debugGrid();
  updateCount();
}

// Original photo left of the before/after line.
function drawSplit(W, H) {
  const {ctx} = S, split = (+$('split').value / 100) * W;
  $('splitLabel').textContent = split ? `${$('split').value} % before` : 'after';
  if (!split) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, split, H); ctx.clip();
  ctx.drawImage(S.img, 0, 0);
  ctx.restore();
  ctx.fillStyle = '#fff';
  ctx.fillRect(split - 2, 0, 4, H);
  label('before', split - 50, 40); label('after', split + 46, 40);
}

// Contact shadows, tree pits and sun shadows on the ground (drawn under every object).
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
        fillGround(crown, `rgba(18, 24, 30, ${0.42 * alpha})`, 6);
        fillGround(quad(o, tip, 0.16), `rgba(18, 24, 30, ${0.38 * alpha})`, 3);
      }
    }
    fillGround(circle(o, p.crown_diameter_m * 0.42), `rgba(10, 14, 10, ${0.22 * alpha})`, 10);
    fillGround(circle(o, 0.6), `rgba(70, 66, 60, ${0.7 * alpha})`, 0);
    fillGround(circle(o, 0.5), `rgba(84, 72, 58, ${0.75 * alpha})`, 0);
  } else {
    const [len, wid] = o.kind === 'car' ? [4.5, 1.85] : [1.8, 0.5];
    const a = o.pose.heading, ax = Math.sin(a), ay = Math.cos(a);
    const c = cam.toEN(o), pts = [];
    for (const [s, l] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
      pts.push(cam.fromEN(c.east + ax * s * len / 2 + ay * l * wid / 2, c.north + ay * s * len / 2 - ax * l * wid / 2));
    }
    fillGround(pts, `rgba(0, 0, 0, ${(o.kind === 'car' ? 0.5 : 0.3) * alpha})`, 4);
  }
}

function fillGround(pts, colour, blur) {
  const proj = pts.map(p => S.cam.project(p.x, 0, p.z));
  if (proj.some(p => !p)) return;
  const {ctx} = S;
  ctx.filter = blur ? `blur(${Math.max(1, blur * proj[0].scale / 40).toFixed(1)}px)` : 'none';
  ctx.fillStyle = colour;
  ctx.beginPath();
  proj.forEach((p, i) => (i ? ctx.lineTo(p.u, p.v) : ctx.moveTo(p.u, p.v)));
  ctx.fill();
  ctx.filter = 'none';
}

const circle = (o, r, n = 28) => Array.from({length: n}, (_, i) => ({x: o.x + r * Math.cos((i / n) * 2 * Math.PI), z: o.z + r * Math.sin((i / n) * 2 * Math.PI)}));

// Thin ground strip from a to b (a trunk shadow), half width w.
function quad(a, b, w) {
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1, nx = (-dz / l) * w, nz = (dx / l) * w;
  return [{x: a.x + nx, z: a.z + nz}, {x: b.x + nx, z: b.z + nz}, {x: b.x - nx, z: b.z - nz}, {x: a.x - nx, z: a.z - nz}];
}

function drawObject(o, litRight) {
  const p = S.cam.project(o.x, 0, o.z);
  if (!p) return null;
  const sp = o.kind === 'tree' ? treeSprite(o.preset, o.seed % 4, litRight)
           : o.kind === 'car' ? carSprite(o.pose.side, o.seed)
           : bikeSprite(o.pose.side, o.seed);
  const k = p.scale / sp.k, w = sp.canvas.width * k, h = sp.canvas.height * k;
  const x0 = p.u - sp.ox * k, y0 = p.v - sp.oy * k, {ctx} = S;
  const haze = Math.min(1, o.depth / 120);  // aerial perspective: paler and flatter with distance
  ctx.save();
  ctx.globalAlpha = o.ghost ? 0.55 : 1;
  ctx.filter = `contrast(${(1 - 0.35 * haze).toFixed(2)}) saturate(${(1 - 0.4 * haze).toFixed(2)}) brightness(${(1 + 0.25 * haze).toFixed(2)})`;
  ctx.imageSmoothingQuality = 'high';
  if (o.pose && o.pose.flip) {
    ctx.translate(p.u, 0); ctx.scale(-1, 1); ctx.translate(-p.u, 0);
  }
  ctx.drawImage(sp.canvas, x0, y0, w, h);
  ctx.restore();
  if (o.kind !== 'tree') return {x0, y0, x1: x0 + w, y1: y0 + h};
  // a tree is picked by its trunk, so you can still plant behind a crown
  const t = S.model.presets[o.preset], half = Math.max(0.5 * p.scale, 8), clear = t.height_m - 2 * Math.min(t.crown_diameter_m * 0.55, (t.height_m - 2.2) / 2);
  return {x0: p.u - half, x1: p.u + half, y0: p.v - clear * p.scale, y1: p.v + 0.4 * p.scale};
}

// Vehicles drive on the right: east of the centre line towards the street axis bearing, west of it the other way.
// Seen from the camera that is a rear, front or side view.
function vehiclePose(o) {
  const {cam, view} = S, A = S.cfg.street_axis_bearing_deg * DEG;
  const {east, north} = cam.toEN(o), lateral = east * Math.cos(A) - north * Math.sin(A);
  const heading = lateral > view.centreline_m ? A : A + Math.PI;
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
  $('count').textContent = `In this view: ${plural(n('tree'), 'tree')}, ${plural(n('car'), 'car')}, ${plural(n('bike'), 'bike')}.`;
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
// Drawn once per variant into an offscreen canvas at PX_PER_M; origin (ox, oy) is the ground point.

function sprite(key, wM, hM, oxM, paint, k = PX_PER_M) {
  if (S.sprites.has(key)) return S.sprites.get(key);
  const c = document.createElement('canvas');
  c.width = Math.ceil(wM * k);
  c.height = Math.ceil(hM * k);
  const g = c.getContext('2d'), ox = oxM * k, oy = c.height - 0.1 * k;
  g.translate(ox, oy);
  g.scale(k, -k);   // metres, y up, origin on the ground
  paint(g);
  const s = {canvas: c, ox, oy, k};
  S.sprites.set(key, s);
  return s;
}

function treeSprite(preset, variant, litRight) {
  const p = S.model.presets[preset], D = p.crown_diameter_m, H = p.height_m;
  const rx = D / 2, ry = Math.min(D * 0.55, (H - 2.2) / 2), cy = H - ry;
  return sprite(`tree|${preset}|${variant}|${litRight}`, D * 1.3 + 0.8, H + 1.0, D * 0.65 + 0.4, g => {
    const rnd = rng(variant * 7919 + D * 31), side = litRight ? 1 : -1, d = 0.12 + D * 0.025;
    // crown outline: overlapping lumps, so every variant gets its own irregular silhouette
    const lumps = [{x: 0, y: cy, rx: rx * 0.72, ry: ry * 0.72}, ...Array.from({length: 10}, () => {
      const a = rnd() * 2 * Math.PI, r = 0.35 + rnd() * 0.25;
      return {x: Math.cos(a) * (1 - r) * rx, y: cy + Math.sin(a) * (1 - r) * ry, rx: r * rx * 1.05, ry: r * ry * 1.05};
    })];
    const inCrown = (x, y) => lumps.some(l => ((x - l.x) / l.rx) ** 2 + ((y - l.y) / l.ry) ** 2 <= 1);
    // gaps in the foliage where sky and branches show through
    const gaps = Array.from({length: Math.round(D * 1.5)}, () => {
      const a = rnd() * 2 * Math.PI, rr = 0.3 + rnd() * 0.6;
      return {x: Math.cos(a) * rr * rx, y: cy + Math.sin(a) * rr * ry, r: (0.25 + rnd() * 0.45) * Math.sqrt(D / 8)};
    });
    const inGap = (x, y) => gaps.some(q => Math.hypot(x - q.x, y - q.y) < q.r * (0.6 + rnd() * 0.6));
    // foliage: many small leaves, lit from the sun's side, darker inside and underneath
    const L = norm([0.45 * side, 0.65, 0.6]), leaves = [];
    for (let i = 0, n = Math.round(1500 + D * D * 110); i < n; i++) {
      const x = (rnd() * 2 - 1) * rx * 1.05, y = cy + (rnd() * 2 - 1) * ry * 1.05;
      if (!inCrown(x, y) || inGap(x, y)) continue;
      const nx = x / rx, ny = (y - cy) / ry, nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) * rnd();
      leaves.push({x, y, nz, r: (0.05 + rnd() * 0.07) * Math.sqrt(D / 8) + 0.03, rot: rnd() * Math.PI,
                   light: Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]), j: rnd()});
    }
    for (const f of leaves.sort((a, b) => a.nz - b.nz)) {
      g.fillStyle = `hsl(${78 + f.j * 30}, ${22 + f.j * 16}%, ${13 + f.light * 22 + f.nz * 6 + f.j * 6}%)`;
      g.beginPath(); g.ellipse(f.x, f.y, f.r, f.r * 0.62, f.rot, 0, 2 * Math.PI); g.fill();
    }
    // shade towards the crown base, on the foliage only
    g.globalCompositeOperation = 'source-atop';
    const under = g.createLinearGradient(0, cy + ry * 0.2, 0, cy - ry);
    under.addColorStop(0, 'rgba(10, 25, 5, 0)');
    under.addColorStop(1, 'rgba(10, 25, 5, 0.45)');
    g.fillStyle = under;
    g.fillRect(-rx * 1.3, cy - ry * 1.2, rx * 2.6, ry * 1.4);
    // branches and trunk, behind the foliage
    g.globalCompositeOperation = 'destination-over';
    g.strokeStyle = '#4a4038';
    g.lineCap = 'round';
    for (let i = 0; i < 7; i++) {
      const y0 = cy - ry * (0.75 - i * 0.1), dir = i % 2 ? 1 : -1;
      g.lineWidth = d * (0.6 - i * 0.06);
      g.beginPath(); g.moveTo(0, y0);
      g.quadraticCurveTo(dir * rx * 0.2, y0 + ry * 0.25, dir * rx * (0.4 + rnd() * 0.35), y0 + ry * (0.4 + rnd() * 0.35));
      g.stroke();
    }
    g.globalCompositeOperation = 'source-over';
    const bark = g.createLinearGradient(-d / 2, 0, d / 2, 0);
    bark.addColorStop(0, litRight ? '#2b2520' : '#665a4f');
    bark.addColorStop(0.5, '#4d433a');
    bark.addColorStop(1, litRight ? '#665a4f' : '#2b2520');
    const trunk = new Path2D(), top = cy - ry * 0.55;
    trunk.moveTo(-d * 0.62, 0); trunk.quadraticCurveTo(-d * 0.45, 0.25, -d * 0.45, 0.6);
    trunk.lineTo(-d * 0.36, top); trunk.lineTo(d * 0.36, top); trunk.lineTo(d * 0.45, 0.6);
    trunk.quadraticCurveTo(d * 0.45, 0.25, d * 0.62, 0); trunk.closePath();
    g.save();
    g.globalCompositeOperation = 'destination-over';
    g.fillStyle = bark;
    g.fill(trunk);
    g.restore();
    g.save();
    g.clip(trunk);
    g.globalCompositeOperation = 'source-atop';
    g.strokeStyle = 'rgba(25, 20, 16, 0.35)';
    g.lineWidth = 0.015;
    for (let i = 0; i < 14; i++) {
      const x = (rnd() - 0.5) * d * 0.8;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (rnd() - 0.5) * 0.05, cy - ry); g.stroke();
    }
    g.restore();
  }, TREE_PX_PER_M);
}

function carSprite(side, seed) {
  const colour = CAR_COLOURS[seed % CAR_COLOURS.length];
  if (side === 'side') return sprite(`car|side|${colour}`, 4.8, 1.7, 2.4, g => carSide(g, colour));
  return sprite(`car|${side}|${colour}`, 2.1, 1.7, 1.05, g => carEnd(g, colour, side === 'front'));
}

function carEnd(g, colour, front) {
  const body = g.createLinearGradient(0, 0.2, 0, 1.0);
  body.addColorStop(0, shade(colour, -0.35));
  body.addColorStop(1, shade(colour, 0.12));
  for (const s of [-1, 1]) { g.fillStyle = '#111'; rrect(g, s * 0.78 - 0.13, 0, 0.26, 0.42, 0.06); }
  g.fillStyle = body;
  rrect(g, -0.9, 0.18, 1.8, 0.8, 0.14);
  g.fillStyle = shade(colour, 0.05);
  g.beginPath(); g.moveTo(-0.84, 0.94); g.lineTo(-0.62, 1.44); g.lineTo(0.62, 1.44); g.lineTo(0.84, 0.94); g.closePath(); g.fill();
  const glass = g.createLinearGradient(0, 1.0, 0, 1.4);
  glass.addColorStop(0, front ? '#2a343c' : '#1b232a');
  glass.addColorStop(1, front ? '#7b8a96' : '#4b5964');
  g.fillStyle = glass;
  g.beginPath(); g.moveTo(-0.72, 1.0); g.lineTo(-0.56, 1.37); g.lineTo(0.56, 1.37); g.lineTo(0.72, 1.0); g.closePath(); g.fill();
  g.fillStyle = shade(colour, -0.45);
  g.fillRect(-0.88, 0.18, 1.76, 0.2);
  for (const s of [-1, 1]) {
    g.fillStyle = front ? '#e9eef5' : '#b3121b';
    rrect(g, s > 0 ? 0.58 : -0.86, front ? 0.62 : 0.66, 0.28, front ? 0.13 : 0.16, 0.04);
    if (front) { g.fillStyle = shade(colour, -0.2); g.fillRect(s * 0.92 - 0.06, 0.95, 0.12, 0.09); }
  }
  if (front) { g.fillStyle = '#20252b'; rrect(g, -0.42, 0.42, 0.84, 0.16, 0.04); }
  g.fillStyle = '#f1f3f5';
  g.fillRect(-0.26, front ? 0.24 : 0.42, 0.52, 0.11);
  g.fillStyle = '#1c3d9e';
  g.fillRect(-0.26, front ? 0.24 : 0.42, 0.05, 0.11);
}

function carSide(g, colour) {
  const body = g.createLinearGradient(0, 0.3, 0, 1.45);
  body.addColorStop(0, shade(colour, -0.3));
  body.addColorStop(0.55, shade(colour, 0.1));
  body.addColorStop(1, shade(colour, -0.05));
  g.fillStyle = body;
  g.beginPath();
  g.moveTo(-2.25, 0.32); g.lineTo(-2.27, 0.82); g.quadraticCurveTo(-2.2, 0.98, -1.9, 1.0);
  g.lineTo(-1.5, 1.02); g.lineTo(-1.02, 1.44); g.lineTo(0.5, 1.46); g.lineTo(1.2, 1.02);
  g.lineTo(2.05, 0.9); g.quadraticCurveTo(2.27, 0.84, 2.27, 0.6); g.lineTo(2.25, 0.32); g.closePath();
  g.fill();
  const glass = g.createLinearGradient(0, 1.0, 0, 1.42);
  glass.addColorStop(0, '#1f282f'); glass.addColorStop(1, '#5d6b77');
  g.fillStyle = glass;
  g.beginPath(); g.moveTo(-1.4, 1.05); g.lineTo(-0.98, 1.38); g.lineTo(0.46, 1.4); g.lineTo(1.08, 1.05); g.closePath(); g.fill();
  g.fillStyle = shade(colour, 0.02);
  g.fillRect(-0.3, 1.04, 0.08, 0.36);
  g.strokeStyle = shade(colour, -0.4); g.lineWidth = 0.02;
  g.beginPath(); g.moveTo(-0.26, 0.42); g.lineTo(-0.26, 1.02); g.moveTo(0.95, 0.45); g.lineTo(0.95, 1.02); g.stroke();
  g.fillStyle = '#b3121b'; g.fillRect(-2.27, 0.68, 0.1, 0.14);
  g.fillStyle = '#e9eef5'; g.fillRect(2.16, 0.64, 0.1, 0.12);
  for (const x of [-1.42, 1.42]) {
    g.fillStyle = '#121212'; g.beginPath(); g.arc(x, 0.34, 0.34, 0, 2 * Math.PI); g.fill();
    g.fillStyle = '#9aa1a8'; g.beginPath(); g.arc(x, 0.34, 0.2, 0, 2 * Math.PI); g.fill();
    g.fillStyle = '#5c636a'; g.beginPath(); g.arc(x, 0.34, 0.06, 0, 2 * Math.PI); g.fill();
  }
}

function bikeSprite(side, seed) {
  const jacket = JACKETS[seed % JACKETS.length];
  if (side === 'side') return sprite(`bike|side|${jacket}`, 2.0, 1.95, 1.0, g => bikeSide(g, jacket));
  return sprite(`bike|${side}|${jacket}`, 0.8, 1.95, 0.4, g => bikeEnd(g, jacket, side === 'front'));
}

function bikeEnd(g, jacket, front) {
  g.fillStyle = '#1b1e22';
  rrect(g, -0.035, 0, 0.07, 0.68, 0.03);
  g.fillStyle = '#2b2f36';
  rrect(g, -0.17, 0.42, 0.13, 0.5, 0.05);
  rrect(g, 0.04, 0.5, 0.13, 0.42, 0.05);
  g.fillStyle = jacket;
  rrect(g, -0.22, 0.88, 0.44, 0.6, 0.1);
  g.strokeStyle = jacket; g.lineWidth = 0.09; g.lineCap = 'round';
  g.beginPath(); g.moveTo(-0.2, 1.38); g.lineTo(-0.3, 1.06); g.moveTo(0.2, 1.38); g.lineTo(0.3, 1.06); g.stroke();
  g.strokeStyle = '#3d434a'; g.lineWidth = 0.03;
  g.beginPath(); g.moveTo(-0.3, 1.05); g.lineTo(0.3, 1.05); g.stroke();
  g.fillStyle = front ? '#d9b99b' : '#3b2f2a';
  g.beginPath(); g.arc(0, 1.6, 0.115, 0, 2 * Math.PI); g.fill();
  g.fillStyle = '#e9ecef';
  g.beginPath(); g.ellipse(0, 1.67, 0.13, 0.08, 0, 0, Math.PI); g.fill();
  g.fillStyle = front ? '#fff8e1' : '#e03131';
  g.fillRect(-0.04, front ? 0.88 : 0.72, 0.08, 0.05);
}

function bikeSide(g, jacket) {
  g.strokeStyle = '#1b1e22'; g.lineWidth = 0.05;
  for (const x of [-0.55, 0.55]) { g.beginPath(); g.arc(x, 0.34, 0.32, 0, 2 * Math.PI); g.stroke(); }
  g.strokeStyle = '#495057'; g.lineWidth = 0.04; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(-0.55, 0.34); g.lineTo(-0.12, 0.82); g.lineTo(0.42, 0.86); g.lineTo(0.55, 0.34);
  g.moveTo(-0.55, 0.34); g.lineTo(0, 0.32); g.lineTo(-0.12, 0.82); g.moveTo(0, 0.32); g.lineTo(0.42, 0.86);
  g.lineTo(0.38, 1.02); g.lineTo(0.5, 1.02); g.stroke();
  g.strokeStyle = '#2b2f36'; g.lineWidth = 0.12; g.lineCap = 'round';
  g.beginPath(); g.moveTo(-0.12, 0.92); g.lineTo(0.12, 0.6); g.lineTo(0.12, 0.3); g.moveTo(-0.12, 0.92); g.lineTo(-0.05, 0.55); g.lineTo(-0.12, 0.3); g.stroke();
  g.strokeStyle = jacket; g.lineWidth = 0.24;
  g.beginPath(); g.moveTo(-0.12, 0.98); g.lineTo(0.14, 1.42); g.stroke();
  g.lineWidth = 0.08;
  g.beginPath(); g.moveTo(0.14, 1.38); g.lineTo(0.42, 1.04); g.stroke();
  g.fillStyle = '#d9b99b';
  g.beginPath(); g.arc(0.24, 1.6, 0.11, 0, 2 * Math.PI); g.fill();
  g.fillStyle = '#e9ecef';
  g.beginPath(); g.ellipse(0.22, 1.66, 0.14, 0.08, 0, 0, Math.PI); g.fill();
}

// ------------------------------------------------------------------ green redesign (AI)
// Whole-street visualisations from the centre of the road, made from the photos by
// scripts/redesign_street.py; shown instead of the photo until a view is picked again.

function showRedesign(id) {
  const r = id && (S.cfg.redesigns || []).find(x => x.id === id);
  $('redesign').hidden = !r;
  $('photo').hidden = !!r;
  for (const b of $('redesigns').children) b.classList.toggle('on', !!r && b.dataset.id === r.id);
  for (const b of $('views').children) b.classList.toggle('on', !r && S.view && b.dataset.id === S.view.id);
  $('redesignNote').textContent = r ? `${r.label}: ${r.description}` : '';
  if (r) $('redesign').src = r.image;
}

// ------------------------------------------------------------------ map hand-off, saving

// Trees from all views go to the map tool (app.js reads them and plants them "by hand").
function toMap() {
  const trees = [], presets = {};
  for (const v of S.cfg.views) {
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

function rrect(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); g.fill(); }

// Lighten (k > 0) or darken (k < 0) a #rrggbb colour.
function shade(hex, k) {
  const v = parseInt(hex.slice(1), 16), ch = s => { const c = (v >> s) & 255; return Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k)); };
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

function rng(seed) {  // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
const round2 = x => Math.round(x * 100) / 100;
const getJSON = async url => (await fetch(url, {cache: 'no-store'})).json();

main().catch(e => { $('hint').textContent = e.message; $('hint').classList.add('err'); });
