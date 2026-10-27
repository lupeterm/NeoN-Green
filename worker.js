// Background computation: interpolates the overlay points to a raster for the
// current view, applies the tree scenario and returns a PNG plus street statistics.
importScripts('model.js');

onmessage = async ({data: job}) => {
  const {id, points, origin, extent, view, size, domain, ramp, params, scenario} = job;
  if (!points.length) return postMessage({id, image: null, stats: null});

  const P = NG.projection(origin[0], origin[1]);
  const base = interpolator(points.map(p => ({...P.toXY(p.lon, p.lat), v: p.v})), params.grid);
  const lo = P.toXY(extent[0], extent[1]), hi = P.toXY(extent[2], extent[3]);
  const inExtent = (x, y) => x >= lo.x && x <= hi.x && y >= lo.y && y <= hi.y;

  let effect = null, stats = null;
  if (scenario && scenario.trees.length) {
    const trees = scenario.trees.map(t => ({...t, ...P.toXY(t.lon, t.lat)}));
    const shadows = trees.map(t => NG.shadowEllipse(t, scenario.sun, params));
    effect = (x, y) => NG.treeEffect(x, y, trees, shadows, scenario.sun, params);
    const section = scenario.section.map(([lon, lat]) => P.toXY(lon, lat));
    stats = corridorStats(section, params.street_corridor_m, base, effect, inExtent);
  }

  const value = (x, y) => {
    if (!inExtent(x, y)) return NaN;
    const b = base(x, y);
    return effect ? b + effect(x, y).dT : b;
  };
  const image = await render(view, size, P, value, domain, ramp.map(hex));
  postMessage({id, image, stats});
};

// Inverse distance weighting. Few points: all of them (sparse sensor networks).
// Many points (e.g. bike tracks): only those within idw_radius_m, else no value.
function interpolator(pts, g) {
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
      const e = effect(x, y);
      n++; before += b; after += b + e.dT;
      maxCooling = Math.min(maxCooling, e.dT);
      if (e.shade > 0.5) shaded += cell * cell;
    }
  }
  return n ? {before: before / n, after: after / n, maxCooling, shadedArea: shaded, area: n * cell * cell} : null;
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
