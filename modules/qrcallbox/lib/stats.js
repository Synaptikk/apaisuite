// modules/qrcallbox/lib/stats.js
//
// Pure helpers: Firestore scan docs → table rows and the numbers the panel
// shows. No chrome.* here so it runs under `node --test`.
//
// Most 1458 scans stay status "pending" forever: the answer happens on the
// radio or in Workvivo, and only a Workvivo reply is written back
// (workvivoResponder*). So "answered" means a recorded responder, not status.

/** Normalize one decoded scans/{id} doc. */
export function scanRow(doc) {
  const responder = doc.workvivoResponderName || doc.claimedByName || "";
  const responseMs = Number.isFinite(doc.workvivoResponseTimeMs)
    ? doc.workvivoResponseTimeMs
    : (doc.claimedAt && doc.timestamp ? doc.claimedAt - doc.timestamp : null);
  return {
    id:         doc.id,
    ts:         doc.timestamp ?? null,
    area:       doc.areaDescription || doc.area || "(no area)",
    baseArea:   doc.area || "(no area)",
    status:     doc.status || "",
    wvPosted:   !!doc.workvivoPostedAt,
    wvChannel:  doc.workvivoChannelName || "",
    radio:      doc.radio?.status || "",
    responder,
    responseMs: responseMs != null && responseMs >= 0 ? responseMs : null,
    test:       !!doc.test,
  };
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param {ReturnType<typeof scanRow>[]} rows  real scans (tests filtered out by the caller)
 * @param {(ts:number)=>{day:number,hour:number}} [clock]  weekday 0=Sun + hour, local by default
 */
export function summarize(rows, clock = (ts) => { const d = new Date(ts); return { day: d.getDay(), hour: d.getHours() }; }) {
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const areas = new Map();
  const people = new Map();
  let posted = 0, announced = 0, answered = 0;
  const responseTimes = [];

  for (const r of rows) {
    if (r.wvPosted) posted++;
    if (r.radio === "announced") announced++;
    if (r.responder) answered++;
    if (r.responseMs != null) responseTimes.push(r.responseMs);
    if (r.ts) { const { day, hour } = clock(r.ts); heat[day][hour]++; }

    const a = areas.get(r.baseArea) ?? { area: r.baseArea, count: 0, answered: 0, lastTs: 0 };
    a.count++;
    if (r.responder) a.answered++;
    a.lastTs = Math.max(a.lastTs, r.ts ?? 0);
    areas.set(r.baseArea, a);

    if (r.responder) {
      const p = people.get(r.responder) ?? { name: r.responder, count: 0, times: [] };
      p.count++;
      if (r.responseMs != null) p.times.push(r.responseMs);
      people.set(r.responder, p);
    }
  }

  return {
    total: rows.length,
    posted,
    announced,
    answered,
    medianResponseMs: median(responseTimes),
    heat,
    heatMax: Math.max(0, ...heat.flat()),
    areas: [...areas.values()].sort((a, b) => b.count - a.count),
    responders: [...people.values()]
      .map((p) => ({ name: p.name, count: p.count, medianMs: median(p.times) }))
      .sort((a, b) => b.count - a.count),
  };
}

/** Radio outcome → short label. Values seen on scans.radio.status. */
export function radioLabel(status) {
  switch (status) {
    case "announced":       return "Announced";
    case "no_clip":         return "No clip for area";
    case "blocked_rate_ip": return "Blocked (repeat scans)";
    case "blocked_hours":   return "Blocked (store closed)";
    case "":                return "—";
    default:                return status;
  }
}
