// Tree cooling model, shared by app.js (shadow outlines) and worker.js (grid).
// Deliberately simple and explainable; every number comes from config/model.json.
//
//   ΔT(x, y) = − shade(x, y) · max_cooling_C · sunFactor              (crown shadow, felt temperature)
//              − max_total_C · (1 − e^(−Σ per_tree_C·g_i / max_total_C)) · dayFactor   (evapotranspiration)
//
// g_i is a Gaussian around tree i. The shadow is the crown (a sphere) projected
// along the sun ray: an ellipse, offset away from the sun and stretched by 1/sin(altitude).
// Coordinates are local metres (x east, y north).
(function (root) {
  const DEG = Math.PI / 180;

  // Equirectangular projection around an origin; accurate to well below 1 % within a city.
  function projection(lon0, lat0) {
    const ky = 111320, kx = 111320 * Math.cos(lat0 * DEG);
    return {
      toXY: (lon, lat) => ({x: (lon - lon0) * kx, y: (lat - lat0) * ky}),
      toLL: (x, y) => [lon0 + x / kx, lat0 + y / ky],
    };
  }

  function sunFactors(sun, p) {
    const altDeg = sun.altitude / DEG;
    const shade = altDeg < p.shade.min_sun_altitude_deg ? 0
      : Math.min(1, Math.sin(sun.altitude) / Math.sin(p.shade.full_effect_sun_altitude_deg * DEG));
    return {shade, et: altDeg > 0 ? 1 : p.evapotranspiration.night_factor};
  }

  // sun: {altitude, azimuth} in radians as returned by SunCalc (azimuth from south, positive towards west).
  // That azimuth is exactly the compass bearing in which the shadow points.
  function shadowEllipse(tree, sun, p) {
    if (sun.altitude / DEG < p.shade.min_sun_altitude_deg) return null;
    const r = tree.crown_diameter_m / 2;
    const crownCentre = tree.height_m - r;
    const dir = [Math.sin(sun.azimuth), Math.cos(sun.azimuth)];
    const dist = crownCentre / Math.tan(sun.altitude);
    return {cx: tree.x + dir[0] * dist, cy: tree.y + dir[1] * dist, a: Math.min(r / Math.sin(sun.altitude), 8 * r), b: r, dir};
  }

  function ellipseRing(e, n = 36) {
    const ring = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * 2 * Math.PI, u = e.a * Math.cos(t), w = e.b * Math.sin(t);
      ring.push([e.cx + u * e.dir[0] - w * e.dir[1], e.cy + u * e.dir[1] + w * e.dir[0]]);
    }
    return ring;
  }

  function shadeAt(x, y, e, soft) {
    const dx = x - e.cx, dy = y - e.cy;
    const u = dx * e.dir[0] + dy * e.dir[1], w = -dx * e.dir[1] + dy * e.dir[0];
    const q = Math.hypot(u / e.a, w / e.b);
    if (q <= 1) return 1;
    const edge = (q - 1) * e.b;
    return edge >= soft ? 0 : 1 - edge / soft;
  }

  // trees: [{x, y, ...}], shadows: matching shadowEllipse() results (or null)
  function treeEffect(x, y, trees, shadows, sun, p) {
    const f = sunFactors(sun, p);
    let shade = 0;
    if (f.shade > 0) {
      for (const e of shadows) {
        if (e && (shade = Math.max(shade, shadeAt(x, y, e, p.shade.soft_edge_m))) === 1) break;
      }
    }
    const et = p.evapotranspiration, two = 2 * et.sigma_m * et.sigma_m;
    let g = 0;
    for (const t of trees) {
      const d2 = (x - t.x) ** 2 + (y - t.y) ** 2;
      if (d2 < 9 * two) g += Math.exp(-d2 / two);
    }
    const etCooling = et.max_total_C * (1 - Math.exp(-g * et.per_tree_C / et.max_total_C)) * f.et;
    return {dT: -(p.shade.max_cooling_C * f.shade * shade + etCooling), shade: shade * (f.shade > 0 ? 1 : 0)};
  }

  // ---- other measures, selectable instead of trees (config/model.json "measures").
  // m is the measure in local metres as built by app.js; returns effect(x, y) -> {dT, shade}, or null for none.
  //
  //   beds      −per_m2_C · Σ area_i·g_i, saturating (air) − felt_on_bed_C · sunFactor on the bed itself
  //   misting   −per_pole_C · Σ g_i, saturating, only during operating_hours
  //   pavement  −air_C · Δalbedo/0.1 over the road (fading beside it) + reflected_felt_C · Δalbedo/0.1 · sunFactor
  //             on road and pavements: brighter roads cool the air a little but reflect sun onto pedestrians
  //   traffic   −C_per_W_m2 · (traffic heat saved) over the road, fading beside it
  function measureEffect(m, sun, minute, p) {
    if (m.kind === 'trees') {
      if (!m.trees.length) return null;
      const shadows = m.trees.map(t => shadowEllipse(t, sun, p));
      return (x, y) => treeEffect(x, y, m.trees, shadows, sun, p);
    }
    const q = p.measures[m.kind], f = sunFactors(sun, p), day = sun.altitude > 0;
    const sat = (v, max) => max * (1 - Math.exp(-v / max));
    if (m.kind === 'beds') {
      if (!m.cells.length) return null;
      const two = 2 * q.sigma_m * q.sigma_m, air = day ? 1 : q.night_factor;
      return bounded(m.cells, 3 * q.sigma_m, (x, y) => {
        let g = 0, on = false;
        for (const c of m.cells) {
          const dx = x - c.x, dy = y - c.y, d2 = dx * dx + dy * dy;
          if (d2 < 9 * two) g += Math.exp(-d2 / two) * c.len * c.w;
          if (!on && Math.abs(dx * c.tx + dy * c.ty) <= c.len / 2 && Math.abs(-dx * c.ty + dy * c.tx) <= c.w / 2) on = true;
        }
        return {dT: -(sat(g * q.per_m2_C, q.max_total_C) * air + (on ? q.felt_on_bed_C * f.shade : 0)), shade: 0};
      });
    }
    if (m.kind === 'misting') {
      const h = minute / 60;
      if (!m.poles.length || h < q.operating_hours[0] || h >= q.operating_hours[1]) return null;
      const two = 2 * q.sigma_m * q.sigma_m;
      return bounded(m.poles, 3 * q.sigma_m, (x, y) => {
        let g = 0;
        for (const c of m.poles) {
          const d2 = (x - c.x) ** 2 + (y - c.y) ** 2;
          if (d2 < 9 * two) g += Math.exp(-d2 / two);
        }
        return {dT: -sat(g * q.per_pole_C, q.max_total_C), shade: 0};
      });
    }
    if (m.kind === 'pavement' || m.kind === 'traffic') {
      const air = m.kind === 'pavement'
        ? q.air_C_per_0_1_albedo * (m.dAlbedo / 0.1) * Math.max(f.shade, q.night_factor)
        : q.C_per_W_m2 * m.dFlux;
      const felt = m.kind === 'pavement' ? q.reflected_felt_C_per_0_1_albedo * (m.dAlbedo / 0.1) * f.shade : 0;
      if (!air && !felt) return null;
      const reach = m.halfWidth + Math.max(q.fade_m, q.sidewalk_m || 0);
      return bounded(m.line, reach, (x, y) => {
        const d = distToPolyline(x, y, m.line) - m.halfWidth;
        const a = d <= 0 ? 1 : Math.max(0, 1 - d / q.fade_m);
        return {dT: -air * a + (d <= (q.sidewalk_m || 0) ? felt : 0), shade: 0};
      });
    }
    return null;
  }

  // Skip the work far from the measure: outside the points' bounding box plus margin there is no effect.
  function bounded(pts, margin, fn) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of pts) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    x0 -= margin; y0 -= margin; x1 += margin; y1 += margin;
    const none = {dT: 0, shade: 0};
    return (x, y) => (x < x0 || x > x1 || y < y0 || y > y1 ? none : fn(x, y));
  }

  // ---- small geometry helpers (local metres), shared by app.js and worker.js

  function distToPolyline(x, y, pts) {
    let best = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
    }
    return best;
  }

  // rings: [outer, ...holes], each [{x, y}, ...] (even-odd rule)
  function inPolygon(x, y, rings) {
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
    }
    return inside;
  }

  root.NG = {DEG, projection, sunFactors, shadowEllipse, ellipseRing, treeEffect, measureEffect, distToPolyline, inPolygon};
})(self);
