// modules/orcmonitor/lib/corridors.js
// Interstate corridor waypoints for the Southeast US.
// Used for distance-to-corridor checks and map rendering.

export const CORRIDORS = {
  "I-75":  [[25.8,-80.2],[28.5,-81.4],[32.5,-83.7],[33.7,-84.4],[34.3,-84.0],
             [34.8,-84.8],[35.05,-85.3],[35.17,-84.87],[35.46,-84.59],
             [35.96,-83.92],[36.6,-83.7],[37.0,-84.5],[38.0,-84.5],[39.1,-84.5]],
  "I-40":  [[35.15,-90.0],[35.15,-89.0],[36.17,-86.78],[36.15,-85.5],
             [36.12,-84.5],[35.96,-83.92],[35.8,-82.8],[35.6,-82.6]],
  "I-24":  [[36.17,-86.78],[35.85,-86.4],[35.47,-86.1],[35.2,-85.5],[35.05,-85.3]],
  "I-59":  [[33.5,-86.8],[33.98,-86.01],[34.44,-85.72],[34.9,-85.55],[35.05,-85.3]],
  "I-65":  [[30.7,-88.1],[32.4,-86.8],[33.5,-86.8],[36.17,-86.78],[38.2,-85.7]],
  "I-81":  [[36.6,-82.2],[36.55,-82.55],[36.3,-82.8],[36.1,-83.5],[35.96,-83.92]],
  "I-85":  [[33.7,-84.4],[33.9,-83.8],[34.3,-83.3],[34.7,-82.9],[35.2,-80.8]],
  "I-20":  [[33.7,-84.4],[33.5,-85.5],[33.5,-86.8],[32.4,-86.8]],
  "I-26":  [[36.3,-82.35],[35.96,-83.92],[35.6,-82.6]],
};

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 3959;
  const dlat = (lat2 - lat1) * Math.PI / 180;
  const dlon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dlat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dlon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function nearestCorridor(lat, lon, thresholdMiles = 35) {
  let best = null, bestDist = Infinity;
  for (const [name, pts] of Object.entries(CORRIDORS)) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [la, loa] = pts[i], [lb, lob] = pts[i+1];
      const ds = lob - loa, dl = lb - la;
      const t = (ds === 0 && dl === 0) ? 0
        : Math.max(0, Math.min(1, ((lon-loa)*ds + (lat-la)*dl) / (ds**2 + dl**2)));
      const d = haversine(lat, lon, la + t*dl, loa + t*ds);
      if (d < bestDist) { bestDist = d; best = name; }
    }
  }
  return bestDist <= thresholdMiles ? { name: best, dist: Math.round(bestDist*10)/10 } : null;
}

export function corridorsGeoJSON() {
  return {
    type: "FeatureCollection",
    features: Object.entries(CORRIDORS).map(([name, pts]) => ({
      type: "Feature",
      properties: { name },
      geometry: { type: "LineString", coordinates: pts.map(([la,lo]) => [lo,la]) },
    })),
  };
}
