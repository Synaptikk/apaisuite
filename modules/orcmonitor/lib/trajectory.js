// modules/orcmonitor/lib/trajectory.js
// Person-level trajectory analysis using geometric direction vectors,
// cluster radius, and corridor alignment — not just distance comparison.

import { haversine, nearestCorridor } from "./corridors.js";
import { getStoreCoords }             from "./store_coords.js";

// ── Geometry helpers ──────────────────────────────────────────────────────────

function toRadians(d) { return d * Math.PI / 180; }

/** Bearing from point A to point B in degrees (0=N, 90=E) */
function bearing(lat1, lon1, lat2, lon2) {
  const dLon = toRadians(lon2 - lon1);
  const la1  = toRadians(lat1), la2 = toRadians(lat2);
  const y    = Math.sin(dLon) * Math.cos(la2);
  const x    = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Signed angular difference between two bearings (-180..180) */
function bearingDiff(a, b) {
  let d = b - a;
  while (d > 180)  d -= 360;
  while (d < -180) d += 360;
  return d;
}

/**
 * Trajectory analysis using:
 *   1. Cluster radius check (tight cluster far away = local operator)
 *   2. Direction vector consistency (% of moves toward target)
 *   3. Minimum displacement threshold (need ≥30 miles net closure)
 *   4. Corridor alignment bonus
 *
 * Returns { approaching, milesPerDay, etaDays, confidence, reason }
 */
function analyzeTrajectory(timedPoints, targetLat, targetLon) {
  if (!timedPoints.length) return { approaching:false, confidence:0, reason:"no_dated_events" };

  const latest = timedPoints[timedPoints.length - 1];
  const oldest = timedPoints[0];

  // ── 1. Cluster radius ─────────────────────────────────────────────────────
  // If all events fit inside a tight radius the person is a local operator,
  // not traveling toward us — even if stores inch slightly closer by chance.
  if (timedPoints.length > 1) {
    const meanLat = timedPoints.reduce((s,p)=>s+p.lat,0)/timedPoints.length;
    const meanLon = timedPoints.reduce((s,p)=>s+p.lon,0)/timedPoints.length;
    const clusterRadius = Math.max(...timedPoints.map(p=>haversine(meanLat,meanLon,p.lat,p.lon)));

    // Tight cluster (< 25 mi) AND far from target (> 100 mi) = local operator
    if (clusterRadius < 25 && latest.dist > 100) {
      return { approaching:false, confidence:0, reason:"local_operator",
               clusterRadius, etaDays:null, milesPerDay:0 };
    }
  }

  // ── 2. Minimum displacement ───────────────────────────────────────────────
  // Require at least 30 miles of net closure — filters geographic noise.
  const maxDist = Math.max(...timedPoints.map(p=>p.dist));
  const netClosure = maxDist - latest.dist;
  if (netClosure < 30 && latest.dist > 60) {
    return { approaching:false, confidence:0, reason:"insufficient_displacement",
             netClosure, etaDays:null, milesPerDay:0 };
  }

  // ── 3. Direction vector consistency ───────────────────────────────────────
  // For each consecutive event pair, score whether movement points toward target.
  // Score = fraction of moves within 60° of the target bearing.
  let alignedMoves = 0, totalMoves = 0;
  for (let i = 0; i < timedPoints.length - 1; i++) {
    const from = timedPoints[i], to = timedPoints[i+1];
    const moveDist = haversine(from.lat, from.lon, to.lat, to.lon);
    if (moveDist < 5) continue;  // skip micro-moves (same-city stores)

    const moveBearing   = bearing(from.lat, from.lon, to.lat, to.lon);
    const targetBearing = bearing(from.lat, from.lon, targetLat, targetLon);
    const angleDiff     = Math.abs(bearingDiff(moveBearing, targetBearing));

    totalMoves++;
    if (angleDiff < 60) alignedMoves++;   // within 60° counts as "toward target"
  }

  // Direction score: 0–1 (1 = always moving toward target)
  const directionScore = totalMoves > 0 ? alignedMoves / totalMoves : 0;

  // Need either good direction score OR very strong displacement
  const approaching = (latest.dist < maxDist - 30) &&
                       (directionScore >= 0.4 || netClosure > 100);

  if (!approaching) {
    return { approaching:false, confidence:directionScore,
             reason: directionScore < 0.4 ? "wrong_direction" : "no_net_approach",
             etaDays:null, milesPerDay:0, directionScore };
  }

  // ── 4. ETA calculation ────────────────────────────────────────────────────
  let milesPerDay = 0, etaDays = null;
  try {
    const daysElapsed = Math.max(
      Math.round((new Date(latest.date) - new Date(oldest.date)) / 86400000), 1
    );
    const closedDist  = oldest.dist - latest.dist;
    milesPerDay = Math.round(closedDist / daysElapsed * 10) / 10;
    if (milesPerDay > 2) {
      etaDays = Math.round(latest.dist / milesPerDay * 10) / 10;
    }
  } catch {}

  // ── 5. Confidence score ───────────────────────────────────────────────────
  // Combines direction consistency, net displacement, and proximity
  const displacementScore = Math.min(1, netClosure / 200);      // 0→1 over 200 miles
  const proximityScore    = Math.max(0, 1 - latest.dist / 300); // closer = higher
  const confidence        = Math.round(
    (directionScore * 0.5 + displacementScore * 0.3 + proximityScore * 0.2) * 100
  ) / 100;

  return { approaching:true, milesPerDay, etaDays, confidence, directionScore,
           netClosure, reason:"directional_approach" };
}

// ── Corridor alignment bonus for risk score ───────────────────────────────────
// Events on the same interstate corridor as the target get a credibility boost.
function corridorAlignmentBonus(timedPoints, targetLat, targetLon) {
  if (!timedPoints.length) return 0;
  const targetCorridor = nearestCorridor(targetLat, targetLon, 80);
  if (!targetCorridor?.name) return 0;

  const onSameCorridor = timedPoints.filter(p => {
    const c = nearestCorridor(p.lat, p.lon, 30);
    return c?.name === targetCorridor.name;
  }).length;

  // Bonus: 0–10 points based on fraction of events on same corridor
  return Math.round((onSameCorridor / timedPoints.length) * 10);
}

// ── Main card builder ─────────────────────────────────────────────────────────

export function buildThreatCard(personId, profile, feedResp, targetLat, targetLon) {
  const hero     = profile.heroCardView         ?? {};
  const details  = profile.personDetailsCardView ?? {};
  const appear   = profile.appearanceCardView    ?? {};
  const locCard  = profile.personLocationCardView ?? {};
  const locCount = profile.locationCount         ?? [];
  const trespasses  = profile.trespasses         ?? [];
  const heatmap     = profile.heatmapData        ?? {};
  const eventTypes  = profile.eventTypeCount     ?? {};
  const products    = profile.productCount       ?? {};
  const vehicles    = profile.associatedVehicles ?? [];
  const accomplices = profile.associatedPersons  ?? [];

  // ── Store markers with exact lat/lon ──────────────────────────────────────
  const markers    = locCard.eventsPerMarker ?? [];
  const storeDists = markers.map(m => {
    const lat = parseFloat(m.latitude), lon = parseFloat(m.longitude);
    if (!lat || !lon) return null;
    return {
      name:   m.name ?? "?",
      lat, lon,
      dist:   Math.round(haversine(targetLat, targetLon, lat, lon) * 10) / 10,
      events: m.eventCount ?? 0,
    };
  }).filter(Boolean).sort((a,b) => a.dist - b.dist);

  if (!storeDists.length) return null;
  const closest = storeDists[0];

  // ── Last activity ─────────────────────────────────────────────────────────
  const lastActivityStr  = hero.lastActivity ?? "";
  const lastActivityDate = lastActivityStr.slice(0, 10);
  let lastSeenDays = null;
  try { lastSeenDays = Math.round((Date.now() - new Date(lastActivityStr)) / 86400000); } catch {}

  // ── 300-mile include filter ───────────────────────────────────────────────
  const DISPLAY_RADIUS = 300;
  if (closest.dist > DISPLAY_RADIUS) return null;

  // ── Single-event filter ───────────────────────────────────────────────────
  // One-off events far away are likely unrelated to your store.
  const totalEvents = hero.totalCountOfEvents ?? hero.countOfEventsAtOrganization ?? 0;
  if (totalEvents <= 1 && closest.dist > 100) return null;

  // ── ProfileFeed: extract chronological events with dates ──────────────────
  const eventsByStore = {};
  const timedPoints   = [];

  for (const group of (feedResp?.groups ?? [])) {
    for (const item of (group.items ?? [])) {
      if (item.activityType !== "EventCreated") continue;
      const p    = item.propsBag ?? {};
      const site = (p.SiteName ?? "").split(",")[0].trim();
      const date = (p.LocalOccurredAt ?? p.OccurredAt ?? "").slice(0, 10);
      const type = p.EventType ?? "";
      const val  = parseFloat((p.TotalValue ?? "$0").replace(/[$,]/g, "")) || 0;
      const eid  = (item.objectId ?? "").replace(/^e/, "");
      if (!site || !date) continue;

      const matched = storeDists.find(s =>
        s.name.split(" - ")[0].trim() === site.split(" - ")[0].trim() ||
        s.name.includes(site)
      );
      const rec = { date, type, value: val, eventId: eid };
      const short = site.split(" - ")[0].trim();
      eventsByStore[short] = [...(eventsByStore[short] ?? []), rec];
      eventsByStore[site]  = [...(eventsByStore[site]  ?? []), rec];

      if (matched) {
        timedPoints.push({ date, lat:matched.lat, lon:matched.lon,
                           dist:matched.dist, site:matched.name, type, value:val });
      }
    }
  }
  timedPoints.sort((a, b) => a.date.localeCompare(b.date));

  // ── Improved trajectory analysis ──────────────────────────────────────────
  const traj = analyzeTrajectory(timedPoints, targetLat, targetLon);

  // Current location = most recent dated event, fallback to closest
  const newestDated = timedPoints.length > 0 ? timedPoints[timedPoints.length - 1] : null;
  let currentLoc = newestDated
    ? { name:newestDated.site, lat:newestDated.lat, lon:newestDated.lon, dist:newestDated.dist }
    : closest;

  // Stale: > 45 days since last seen → no ETA
  const stale = lastSeenDays !== null && lastSeenDays > 45;
  const approaching = traj.approaching && !stale;
  const etaDays     = approaching ? traj.etaDays : null;
  const milesPerDay = traj.milesPerDay ?? 0;
  const etaDate     = etaDays != null
    ? new Date(Date.now() + etaDays * 86400000).toLocaleDateString("en-US",{month:"short",day:"numeric"})
    : "Unknown";

  // ── ORC corridors ─────────────────────────────────────────────────────────
  const orcCorridors = locCount.filter(lc => lc.key === "ORC CORRIDOR").map(lc => lc.value);
  const localCorridors = orcCorridors.filter(c =>
    /CHATTANOOGA|ATLANTA|KNOXVILLE|NASHVILLE|BIRMINGHAM|24|40\/75|59|75\/81|85|65/.test(c)
  );
  let corridor = null;
  for (const oc of (localCorridors.length ? localCorridors : orcCorridors)) {
    if (/75/.test(oc)) { corridor = "I-75"; break; }
    if (/24/.test(oc)) { corridor = "I-24"; break; }
    if (/40/.test(oc)) { corridor = "I-40"; break; }
    if (/59/.test(oc)) { corridor = "I-59"; break; }
    if (/81/.test(oc)) { corridor = "I-81"; break; }
    if (/65/.test(oc)) { corridor = "I-65"; break; }
    if (/85/.test(oc)) { corridor = "I-85"; break; }
  }
  if (!corridor) { const nc = nearestCorridor(currentLoc.lat, currentLoc.lon); corridor = nc?.name ?? null; }

  // ── Physical description ──────────────────────────────────────────────────
  const appParts = [];
  for (const av of (appear.appearanceViews ?? [])) {
    for (const det of (av.details ?? [])) {
      if (det.key === "PersonGender")          appParts.unshift(det.value);
      else if (det.key === "PersonBuild")      appParts.push(det.value + " build");
      else if (det.key === "PersonEstimatedHeight") appParts.push(det.value);
    }
  }
  try {
    const dob = details.birthdays?.[0]?.value;
    if (dob) appParts.push(Math.floor((Date.now() - new Date(dob)) / (365.25*86400000)) + " yrs");
  } catch {}

  // ── Time-of-day ───────────────────────────────────────────────────────────
  const hourCounts = new Array(24).fill(0);
  for (const [key, cnt] of Object.entries(heatmap)) {
    const h = parseInt(key.split("_")[1], 10);
    if (!isNaN(h)) hourCounts[h] += cnt;
  }
  const peakHour  = hourCounts.indexOf(Math.max(...hourCounts));
  const peakHoursLabel = _fmtHour(peakHour);

  const primaryMo = Object.entries(eventTypes).sort((a,b)=>b[1]-a[1])[0]?.[0] ?? "Unknown";
  const totalValue = (hero.totalMoneyValue?.value ?? hero.totalMoneyValueAtOrganization?.value ?? 0);

  // ── Risk score ────────────────────────────────────────────────────────────
  const corridorBonus = corridorAlignmentBonus(timedPoints, targetLat, targetLon);
  let score = 0;
  score += Math.max(0, 40 - Math.floor(currentLoc.dist / 10));    // proximity
  if (etaDays != null) score += Math.max(0, 25 - Math.floor(etaDays * 3)); // ETA
  if (lastSeenDays != null) {
    if (lastSeenDays <= 7)  score += 20;
    else if (lastSeenDays <= 14) score += 15;
    else if (lastSeenDays <= 30) score += 10;
    else if (lastSeenDays <= 45) score += 5;
  }
  if (approaching)              score += Math.round((traj.confidence ?? 0) * 10); // trajectory quality
  if (vehicles.some(v=>v.identityGroupPrimaryIdentifier)) score += 2;
  if (accomplices.length >= 2)  score += 3;
  score += corridorBonus;        // interstate alignment
  if (traj.reason === "local_operator") score = Math.min(score, 20); // cap local operators
  score = Math.min(100, Math.max(0, score));

  // ── 300-mile store history cap ────────────────────────────────────────────
  const distantCount = storeDists.filter(s => s.dist > 300).length;
  const storeHistory = storeDists
    .filter(s => s.dist <= 300)
    .map(s => {
      const short  = s.name.split(" - ")[0].trim();
      const evts   = eventsByStore[short] ?? eventsByStore[s.name] ?? [];
      evts.sort((a,b) => b.date.localeCompare(a.date));
      const latest = evts[0] ?? {};
      return {
        store:  s.name,
        dist:   s.dist,
        events: s.events,
        lat:    s.lat, lon: s.lon,
        date:   s.name === currentLoc.name && !latest.date ? lastActivityDate : (latest.date ?? ""),
        type:   latest.type ?? "",
        value:  latest.value ?? 0,
      };
    }).sort((a,b) => b.date.localeCompare(a.date));

  // ── Name with fallback ────────────────────────────────────────────────────
  const rawName = (hero.primaryIdentifier || details.primaryName?.value || "").trim();
  const name    = rawName || "Name Unknown";

  const photos = (hero.profileImages ?? []).map(img => img.thumbnailMediumUrl).filter(Boolean);

  return {
    personId,
    name,
    photos,
    physicalDesc:     appParts.join(" · ") || "No description",
    totalValue:       Math.round(totalValue * 100) / 100,
    eventCount:       totalEvents,
    primaryMo:        _fmtType(primaryMo),
    moBreakdown:      Object.fromEntries(Object.entries(eventTypes).map(([k,v])=>[_fmtType(k),v])),
    productsTargeted: Object.keys(products).slice(0, 6),
    accompliceCount:  accomplices.length,
    accomplices:      accomplices.map(a => a.identityGroupPrimaryIdentifier ?? a.entityIdentityGroupId ?? "?").slice(0, 3),
    vehicles:         vehicles.map(v => v.identityGroupPrimaryIdentifier ?? "Unknown vehicle").filter(Boolean).slice(0, 3),
    trespassNotices:  trespasses.map(t => `${t.siteName ?? "?"} (${t.endDate ? "exp:"+t.endDate : "Indefinite"})`).slice(0, 3),
    addresses:        (details.address ?? []).map(a => a.value).filter(Boolean).slice(0, 2),
    orcCorridors,
    hourCounts,
    peakHours:        peakHoursLabel,
    approaching,
    trajReason:       traj.reason,       // "directional_approach" | "local_operator" | etc.
    trajConfidence:   traj.confidence,
    directionScore:   traj.directionScore,
    currentDist:      currentLoc.dist,
    lat:              currentLoc.lat,
    lon:              currentLoc.lon,
    lastSeenStore:    currentLoc.name,
    lastSeenDate:     lastActivityDate,
    lastSeenDays,
    milesPerDay,
    etaDays,
    etaDate,
    corridor,
    corridorAligned:  corridorBonus > 5,
    threatening:      !!(hero.behaviorCounts?.length),
    storeHistory,
    distantStoreCount: distantCount,
    timedPoints,
    riskScore:        score,
    aurorUrl:         `https://app.us.auror.co/person/${personId}`,
  };
}

function _fmtType(t) {
  const m = {
    ECommFraud:"eComm Fraud", PosScoFraud:"POS/SCO Fraud", Shoptheft:"Shoplifting",
    ThirdPartyAgentTheft:"3rd Party Theft", CurrencyFraud:"Currency Fraud",
    Fraud:"Fraud", Robbery:"Robbery", Burglary:"Burglary", RefundFraud:"Refund Fraud",
    GeneralIntel:"General Intel", CashTheft:"Cash Theft", SleightOfHandTillSnatch:"Till Snatch",
    BreachOfTrespass:"Trespass", DeniedEntry:"Denied Entry",
  };
  return m[t] ?? t;
}

function _fmtHour(h) {
  if (h < 0 || h > 23) return "Unknown";
  const ampm = h < 12 ? "am" : "pm";
  const h12  = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}${ampm}`;
}
