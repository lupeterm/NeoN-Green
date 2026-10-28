// Background computation: interpolates the overlay points to a raster for the
// current view, applies the tree scenario and returns a PNG plus street statistics.
importScripts('model.js');

onmessage = async ({data: job}) => {
  const {id, points, origin, extent, view, size, domain, ramp, params, scenario, interpolation} = job;
  if (!points.length) return postMessage({id, image: null, stats: null});

  const P = NG.projection(origin[0], origin[1]);
  const base = interpolator(points.map(p => ({...P.toXY(p.lon, p.lat), v: p.v})), params.grid, interpolation);
  const lo = P.toXY(extent[0], extent[1]), hi = P.toXY(extent[2], extent[3]);
  const inExtent = (x, y) => x >= lo.x && x <= hi.x && y >= lo.y && y <= hi.y;

  // effect(x, y, b) -> {d: change of the value b at (x, y), shade}, depending on what the data measures
  let effect = null, stats = null;
  if (scenario && scenario.trees.length) {
    const trees = scenario.trees.map(t => ({...t, ...P.toXY(t.lon, t.lat)}));
    const section = scenario.section.map(([lon, lat]) => P.toXY(lon, lat));
    const corridor = params.street_corridor_m, quantity = scenario.quantity || 'temperature';
    let extra = {};
    if (quantity === 'temperature') {
      const shadows = trees.map(t => NG.shadowEllipse(t, scenario.sun, params));
      effect = (x, y) => { const e = NG.treeEffect(x, y, trees, shadows, scenario.sun, params); return {d: e.dT, shade: e.shade}; };
    } else {
      // pollution and noise act on the street as a whole: full inside the corridor, fading over 5 m
      const fade = (x, y) => { const d = NG.distToPolyline(x, y, section); return d <= corridor ? 1 : Math.max(0, 1 - (d - corridor) / 5); };
      const coverage = crownCover(section, corridor, trees);
      const pct = quantity === 'pm' ? NG.pollutionChangePct(coverage, scenario.canyonShare, params) : 0;
      effect = quantity === 'pm' ? (x, y, b) => ({d: b * (pct / 100) * fade(x, y), shade: 0})
                                 : (x, y) => ({d: params.noise.tree_row_dB * fade(x, y), shade: 0});
      extra = {coverage, pct};
    }
    stats = corridorStats(section, corridor, base, effect, inExtent);
    if (stats) Object.assign(stats, extra, {quantity});
  }

  const value = (x, y) => {
    if (!inExtent(x, y)) return NaN;
    const b = base(x, y);
    return effect && b === b ? b + effect(x, y, b).d : b;
  };
  const image = await render(view, size, P, value, domain, ramp.map(hex));
  postMessage({id, image, stats});
};

// Inverse distance weighting. Few points: all of them (sparse sensor networks).
// Many points (e.g. bike tracks): only those within idw_radius_m, else no value.
// Gridded data (overlay "interpolation": {"mode": "nearest", "radius_m": ...}) keeps the value of
// the nearest point instead, so mapped bands stay crisp.
function interpolator(pts, g, interp) {
  if (interp?.mode === 'nearest') return nearest(pts, interp.radius_m || 20);
  const pow = g.idw_power / 2;
  const fold = (x, y, list, r2) => {
    let sw = 0, s = 0;
    for (const p of list) {
      const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d2 > r2) continue;
      if (d2 < 0.25) return p.v;
      const w = 1 / d2 ** pow;
      sw += w; s += w * p.v;
    }
    return sw ? s / sw : NaN;
  };
  if (pts.length <= g.dense_point_threshold) return (x, y) => fold(x, y, pts, Infinity);

  const R = g.idw_radius_m, buckets = new Map(), key = (i, j) => i * 100003 + j;
  for (const p of pts) {
    const k = key(Math.floor(p.x / R), Math.floor(p.y / R));
    (buckets.get(k) || buckets.set(k, []).get(k)).push(p);
  }
  return (x, y) => {
    const i = Math.floor(x / R), j = Math.floor(y / R), near = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const b = buckets.get(key(i + di, j + dj));
      if (b) near.push(...b);
    }
    return fold(x, y, near, R * R);
  };
}

function nearest(pts, R) {
  const buckets = new Map(), key = (i, j) => i * 100003 + j;
  for (const p of pts) {
    const k = key(Math.floor(p.x / R), Math.floor(p.y / R));
    (buckets.get(k) || buckets.set(k, []).get(k)).push(p);
  }
  return (x, y) => {
    const i = Math.floor(x / R), j = Math.floor(y / R);
    let best = R * R, v = NaN;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const p of buckets.get(key(i + di, j + dj)) || []) {
        const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d2 < best) { best = d2; v = p.v; }
      }
    }
    return v;
  };
}

// Mean value in a corridor around the selected street section, before and after.
function corridorStats(section, corridor, base, effect, inExtent) {
  const xs = section.map(p => p.x), ys = section.map(p => p.y);
  const x0 = Math.min(...xs) - corridor, x1 = Math.max(...xs) + corridor;
  const y0 = Math.min(...ys) - corridor, y1 = Math.max(...ys) + corridor;
  const cell = Math.max(1, Math.sqrt(((x1 - x0) * (y1 - y0)) / 150000));
  let n = 0, before = 0, after = 0, maxCooling = 0, shaded = 0;
  for (let y = y0 + cell / 2; y < y1; y += cell) {
    for (let x = x0 + cell / 2; x < x1; x += cell) {
      if (!inExtent(x, y) || NG.distToPolyline(x, y, section) > corridor) continue;
      const b = base(x, y);
      if (b !== b) continue;
      const e = effect(x, y, b);
      n++; before += b; after += b + e.d;
      maxCooling = Math.min(maxCooling, e.d);
      if (e.shade > 0.5) shaded += cell * cell;
    }
  }
  return n ? {before: before / n, after: after / n, maxCooling, shadedArea: shaded, area: n * cell * cell} : null;
}

// Share of the street corridor under the crowns of the new trees (0..1).
function crownCover(section, corridor, trees) {
  const xs = section.map(p => p.x), ys = section.map(p => p.y);
  const x0 = Math.min(...xs) - corridor, x1 = Math.max(...xs) + corridor;
  const y0 = Math.min(...ys) - corridor, y1 = Math.max(...ys) + corridor;
  const cell = Math.max(1, Math.sqrt(((x1 - x0) * (y1 - y0)) / 100000));
  let n = 0, covered = 0;
  for (let y = y0 + cell / 2; y < y1; y += cell) {
    for (let x = x0 + cell / 2; x < x1; x += cell) {
      if (NG.distToPolyline(x, y, section) > corridor) continue;
      n++;
      if (trees.some(t => (x - t.x) ** 2 + (y - t.y) ** 2 <= (t.crown_diameter_m / 2) ** 2)) covered++;
    }
  }
  return n ? covered / n : 0;
}

async function render([w, s, e, n], [W, H], P, value, [d0, d1], colors) {
  const img = new ImageData(W, H), px = img.data;
  for (let r = 0; r < H; r++) {
    const lat = n - ((r + 0.5) * (n - s)) / H;
    for (let c = 0; c < W; c++) {
      const {x, y} = P.toXY(w + ((c + 0.5) * (e - w)) / W, lat);
      const v = value(x, y), o = (r * W + c) * 4;
      if (v !== v) continue;
      const t = Math.max(0, Math.min(1, (v - d0) / (d1 - d0))) * (colors.length - 1);
      const k = Math.min(colors.length - 2, Math.floor(t)), f = t - k;
      for (let ch = 0; ch < 3; ch++) px[o + ch] = colors[k][ch] + (colors[k + 1][ch] - colors[k][ch]) * f;
      px[o + 3] = 255;
    }
  }
  const canvas = new OffscreenCanvas(W, H);
  canvas.getContext('2d').putImageData(img, 0, 0);
  return {blob: await canvas.convertToBlob({type: 'image/png'}), coordinates: [[w, n], [e, n], [e, s], [w, s]]};
}

function hex(h) {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
