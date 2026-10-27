// Tree cooling model, shared by app.js (shadow outlines) and worker.js (grid).
// Deliberately simple and explainable; every number comes from config/model.json.
//
//   ΔT(x, y) = − shade(x, y) · max_cooling_K · sunFactor              (crown shadow, felt temperature)
//              − max_total_K · (1 − e^(−Σ per_tree_K·g_i / max_total_K)) · dayFactor   (evapotranspiration)
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
    const etCooling = et.max_total_K * (1 - Math.exp(-g * et.per_tree_K / et.max_total_K)) * f.et;
    return {dT: -(p.shade.max_cooling_K * f.shade * shade + etCooling), shade: shade * (f.shade > 0 ? 1 : 0)};
  }

  root.NG = {DEG, projection, sunFactors, shadowEllipse, ellipseRing, treeEffect};
})(self);
