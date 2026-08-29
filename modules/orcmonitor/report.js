// modules/orcmonitor/report.js
// Runs inside the report.html extension page.
// Reads threat data from session storage, builds the AP intelligence brief,
// and auto-triggers the print dialog.

(async () => {
  const got  = await chrome.storage.session.get("orcmonitor.report_data");
  const data = got?.["orcmonitor.report_data"];

  if (!data) {
    document.getElementById("loading").innerHTML =
      "<p style='color:#B91C1C;padding:20px'>Report data not found.<br>Please click Export PDF again from the ORC Monitor.</p>";
    return;
  }

  const { threats = [], target = {}, storeNum = "?", generatedAt, mapPng } = data;
  const now = new Date(generatedAt || Date.now());

  const high = threats.filter(t => t.riskScore >= 70).length;
  const med  = threats.filter(t => t.riskScore >= 45 && t.riskScore < 70).length;
  const totalVal = threats.reduce((s, t) => s + (t.totalValue ?? 0), 0);

  // ── Map ──────────────────────────────────────────────────────────────────
  const mapSrc = mapPng || buildSvgMap(target, threats);

  // ── Cards ─────────────────────────────────────────────────────────────────
  const rows = threats.map(t => {
    const rc  = t.riskScore >= 70 ? "#B91C1C" : t.riskScore >= 45 ? "#D97706" : "#CA8A04";
    const lc  = (t.lastSeenDays ?? 99) <= 14 ? "#B91C1C" : (t.lastSeenDays ?? 99) <= 30 ? "#D97706" : "#374151";
    const photo = (t.photos ?? []).length
      ? `<img src="${t.photos[0]}" style="width:52px;height:52px;object-fit:cover;border-radius:4px">`
      : `<div style="width:52px;height:52px;background:#f0f0f0;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:18px">👤</div>`;
    const hist = (t.storeHistory ?? []).slice(0, 4).map(s =>
      `<tr><td style="padding:2px 6px;font-size:11px">${(s.store ?? "?").split(" - ")[0]}</td>
       <td style="padding:2px 6px;font-size:11px;color:#0071CE">${s.date ?? ""}</td>
       <td style="padding:2px 6px;font-size:11px;text-align:right">${s.dist ?? ""} mi</td></tr>`
    ).join("");
    const moPills = Object.entries(t.moBreakdown ?? {}).sort((a,b)=>b[1]-a[1]).slice(0,3)
      .map(([k,v])=>`<span style="font-size:10px;background:#E8EEF9;color:#0071CE;border-radius:4px;padding:1px 5px">${k} ×${v}</span>`).join(" ");
    const orcTags = (t.orcCorridors ?? []).slice(0,2)
      .map(c=>`<span style="font-size:9px;background:#FEF3C7;color:#D97706;border-radius:3px;padding:1px 4px">${c.replace("ORC CORRIDOR ","")}</span>`).join(" ");

    return `
<div style="page-break-inside:avoid;margin-bottom:8px;border:1px solid #E5E7EB;border-radius:7px;overflow:hidden;border-left:4px solid ${rc}">
  <div style="background:#F9FAFB;padding:7px 10px;display:flex;align-items:flex-start;gap:10px;border-bottom:1px solid #E5E7EB">
    ${photo}
    <div style="flex:1">
      <div style="font-size:13px;font-weight:700">
        <a href="${t.aurorUrl}" style="color:#0071CE;text-decoration:none">${t.name}</a>
      </div>
      <div style="font-size:11px;color:#6B7280;margin-top:1px">${t.physicalDesc ?? ""}</div>
      <div style="font-size:11px;margin-top:4px">
        Last seen: <strong style="color:${lc}">${t.lastSeenDays ?? "?"}d ago</strong>
        at <strong>${(t.lastSeenStore ?? "?").split(" - ")[0]}</strong>
        <span style="color:#6B7280">${t.lastSeenDate ?? ""}</span>
      </div>
      <div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">${moPills}</div>
      ${orcTags ? `<div style="margin-top:3px;display:flex;gap:3px">${orcTags}</div>` : ""}
      ${t.threatening ? `<div style="font-size:10px;color:#B91C1C;font-weight:600;margin-top:3px">⚠ THREATENING BEHAVIOR ON FILE</div>` : ""}
      ${(t.accompliceCount ?? 0) > 0 ? `<div style="font-size:10px;color:#6B7280">👥 ${t.accompliceCount} accomplice${t.accompliceCount > 1 ? "s" : ""}</div>` : ""}
    </div>
    <div style="text-align:right;min-width:110px">
      <div style="font-size:22px;font-weight:700;color:${rc}">${t.riskScore ?? 0}</div>
      <div style="font-size:9px;color:#6B7280;text-align:center">RISK</div>
      <div style="font-size:10px;font-weight:600;margin-top:4px;padding:3px 8px;border-radius:999px;background:${rc}22;color:${rc};border:1px solid ${rc}">
        ${t.etaDays ? `ETA ~${t.etaDays}d · ${t.etaDate}` : "ETA Unknown"}
      </div>
      <div style="font-size:11px;color:#6B7280;margin-top:4px">${t.currentDist ?? ""} mi away</div>
      ${t.corridor ? `<div style="font-size:10px;color:#0071CE">${t.corridor}</div>` : ""}
    </div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0;border-bottom:1px solid #E5E7EB">
    ${[["Value","$"+(t.totalValue??0).toLocaleString("en-US",{minimumFractionDigits:2})],
       ["Events",t.eventCount??0],["MO",t.primaryMo??"?"],["Peak",t.peakHours??"?"]].map(([l,v])=>
      `<div style="padding:5px 8px;border-right:1px solid #F0F1F4">
        <div style="font-size:10px;color:#6B7280;text-transform:uppercase">${l}</div>
        <div style="font-size:13px;font-weight:600;color:#1A1A1A">${v}</div>
      </div>`).join("")}
  </div>
  ${hist ? `<div style="padding:6px 10px">
    <div style="font-size:9px;color:#6B7280;text-transform:uppercase;margin-bottom:3px">Store History · within 300 mi · newest first</div>
    <table style="width:100%;border-collapse:collapse">
      <tr style="background:#F9FAFB">
        <th style="padding:2px 6px;font-size:10px;text-align:left;color:#6B7280">Store</th>
        <th style="padding:2px 6px;font-size:10px;text-align:left;color:#6B7280">Date</th>
        <th style="padding:2px 6px;font-size:10px;text-align:right;color:#6B7280">Distance</th>
      </tr>${hist}
    </table></div>` : ""}
  <div style="padding:3px 10px;background:#F9FAFB;border-top:1px solid #E5E7EB;font-size:10px">
    <a href="${t.aurorUrl}" style="color:#0071CE">View full profile in Auror →</a>
  </div>
</div>`;
  }).join("");

  // ── Inject full report HTML ───────────────────────────────────────────────
  const html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<title>ORC Brief — Store ${storeNum} — ${now.toLocaleDateString()}</title>
<style>
  body{font-family:'Segoe UI',Arial,sans-serif;margin:0;background:#fff;color:#1A1A1A}
  @media print{@page{margin:0.35in}body{margin:0}.no-print{display:none!important}.page{padding:14px}}
  .page{max-width:860px;margin:0 auto;padding:28px}
</style></head><body><div class="page">

  <div style="background:#003087;color:#fff;padding:18px 24px;border-radius:8px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:flex-start">
    <div>
      <div style="font-size:10px;letter-spacing:1px;color:#90b8e0;text-transform:uppercase">Walmart Asset Protection — Internal Use Only</div>
      <div style="font-size:20px;font-weight:700;margin:3px 0">ORC Corridor Intelligence Brief</div>
      <div style="font-size:13px;color:#90b8e0">Store #${storeNum} · 300-Mile Threat Radius</div>
    </div>
    <div style="text-align:right;font-size:11px;color:#90b8e0">
      <div style="font-size:15px;font-weight:700;color:#fff">${now.toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}</div>
      <div>APAISuite · ORC Monitor</div>
    </div>
  </div>

  <div style="background:#FEF3C7;border:1px solid #FFC107;border-radius:6px;padding:8px 14px;margin-bottom:14px;font-size:11px;color:#856404">
    ⚠ <strong>AP INTELLIGENCE BRIEFING — NOT FOR EXTERNAL DISTRIBUTION.</strong>
    ORC threat actors with activity suggesting movement toward Store ${storeNum}. Share with Market AP for coordinated awareness.
  </div>

  <div style="margin-bottom:16px;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden">
    <div style="background:#F0F4F8;padding:5px 12px;font-size:10px;font-weight:700;color:#374151;border-bottom:1px solid #E5E7EB">
      THREAT CORRIDOR MAP — 200-Mile Alert Radius
    </div>
    <img src="${mapSrc}" style="width:100%;display:block;max-height:300px;object-fit:contain" alt="Corridor map"/>
    <div style="padding:4px 12px;font-size:9px;color:#9CA3AF">● Blue circle = Store ${storeNum} · ● Colored dots = ORC actor last-known locations</div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px">
    <div style="background:#FCEAEA;border:1px solid #F5C6C6;border-radius:8px;padding:10px;text-align:center">
      <div style="font-size:26px;font-weight:700;color:#B91C1C">${high}</div>
      <div style="font-size:10px;color:#6B7280;text-transform:uppercase">Arriving &lt; 3 Days</div>
    </div>
    <div style="background:#FEF3C7;border:1px solid #FFE0A0;border-radius:8px;padding:10px;text-align:center">
      <div style="font-size:26px;font-weight:700;color:#D97706">${med}</div>
      <div style="font-size:10px;color:#6B7280;text-transform:uppercase">Arriving 3–7 Days</div>
    </div>
    <div style="background:#E8EEF9;border:1px solid #BEE3F8;border-radius:8px;padding:10px;text-align:center">
      <div style="font-size:26px;font-weight:700;color:#0071CE">${threats.length}</div>
      <div style="font-size:10px;color:#6B7280;text-transform:uppercase">Total Threats</div>
    </div>
    <div style="background:#E3F5E8;border:1px solid #B2DFDB;border-radius:8px;padding:10px;text-align:center">
      <div style="font-size:20px;font-weight:700;color:#1A7F37">$${Math.round(totalVal/1000)}k</div>
      <div style="font-size:10px;color:#6B7280;text-transform:uppercase">Combined Value</div>
    </div>
  </div>

  <div style="font-size:13px;font-weight:700;color:#1A1A1A;margin-bottom:10px;border-bottom:2px solid #003087;padding-bottom:5px">
    IDENTIFIED THREAT ACTORS — Sorted by Risk Score
  </div>
  ${rows || `<div style="color:#6B7280;padding:20px;text-align:center">No threats identified.</div>`}

  <div style="margin-top:24px;padding-top:12px;border-top:1px solid #E5E7EB;font-size:10px;color:#9CA3AF;display:flex;justify-content:space-between">
    <div>Source: Auror · APAISuite ORC Monitor · ${now.toISOString().slice(0,19)} UTC</div>
    <div style="text-align:right">Store ${storeNum} · CONFIDENTIAL — Internal AP Use Only</div>
  </div>

  <div class="no-print" style="margin-top:20px;text-align:center;padding-bottom:20px">
    <button id="btn-print" style="background:#003087;color:#fff;border:none;border-radius:6px;padding:12px 32px;font-size:14px;font-weight:600;cursor:pointer">
      Print / Save as PDF
    </button>
    <p style="margin-top:8px;font-size:11px;color:#6B7280">In the print dialog → Destination → "Save as PDF"</p>
  </div>
</div>
</body></html>`;

  document.open();
  document.write(html);
  document.close();

  // The button used to be wired by an inline <script> written into the markup
  // above. report.html is an extension page, so MV3's default `script-src
  // 'self'` blocked it and the button had never once worked — the only reason
  // printing happened at all is the auto-open below. Wiring it from here, which
  // IS a 'self' script, is the same fix vizpick/lib/card_report.js took.
  document.getElementById("btn-print")?.addEventListener("click", () => window.print());

  // Auto-open print dialog after content renders
  setTimeout(() => window.print(), 1000);
})();

// ── SVG map (no external requests) ───────────────────────────────────────────
function buildSvgMap(target, threats) {
  const W = 700, H = 280;
  const clat = target.lat ?? 35.0, clon = target.lon ?? -85.2;
  const latSpan = 3.75, lonSpan = 5.6;
  const minLat = clat - latSpan, maxLat = clat + latSpan;
  const minLon = clon - lonSpan, maxLon = clon + lonSpan;

  function proj(lat, lon) {
    return [
      Math.round(((lon-minLon)/(maxLon-minLon))*W*10)/10,
      Math.round((H-((lat-minLat)/(maxLat-minLat))*H)*10)/10,
    ];
  }

  let grid = "";
  for (let lat=Math.ceil(minLat); lat<=Math.floor(maxLat); lat++) {
    const [,y]=proj(lat,clon); if(y<0||y>H) continue;
    grid+=`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#CBD5E0" stroke-width="0.5" stroke-dasharray="3,3"/>`;
    grid+=`<text x="3" y="${y-2}" font-size="7" fill="#9CA3AF" font-family="sans-serif">${lat}°N</text>`;
  }
  for (let lon=Math.ceil(minLon); lon<=Math.floor(maxLon); lon++) {
    const [x]=proj(clat,lon); if(x<10||x>W) continue;
    grid+=`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#CBD5E0" stroke-width="0.5" stroke-dasharray="3,3"/>`;
    grid+=`<text x="${x+2}" y="${H-3}" font-size="7" fill="#9CA3AF" font-family="sans-serif">${Math.abs(lon)}°W</text>`;
  }

  const CITIES=[[35.04,-85.31,"Chattanooga"],[33.75,-84.39,"Atlanta"],[36.17,-86.78,"Nashville"],
    [35.96,-83.92,"Knoxville"],[33.52,-86.80,"Birmingham"],[34.73,-86.59,"Huntsville"],
    [34.27,-85.23,"Rome GA"],[34.77,-84.97,"Dalton"],[35.47,-86.46,"Tullahoma"],
    [36.57,-87.36,"Clarksville"],[35.23,-80.84,"Charlotte"]];
  const cities=CITIES.map(([la,lo,name])=>{
    if(la<minLat||la>maxLat||lo<minLon||lo>maxLon) return "";
    const[x,y]=proj(la,lo);
    const big=["Atlanta","Nashville","Knoxville","Charlotte","Birmingham"].includes(name);
    return `<circle cx="${x}" cy="${y}" r="${big?3:2}" fill="#6B7280" stroke="white" stroke-width="0.5"/>
            <text x="${x+4}" y="${y+3}" font-size="${big?8:7}" fill="#374151" font-family="sans-serif" font-weight="${big?"bold":"normal"}">${name}</text>`;
  }).join("");

  const SEGS=[
    [[25.8,-80.2],[32.5,-83.7],[33.7,-84.4],[34.8,-84.8],[35.05,-85.3],[35.96,-83.92],[37.0,-84.5]],
    [[35.15,-90.0],[36.17,-86.78],[35.96,-83.92]],
    [[36.17,-86.78],[35.05,-85.3]],
    [[33.5,-86.8],[34.44,-85.72],[35.05,-85.3]],
    [[30.7,-88.1],[33.5,-86.8],[36.17,-86.78]],
    [[33.7,-84.4],[34.7,-82.9],[35.2,-80.8]],
  ];
  const corridors=SEGS.map(pts=>{
    const d=pts.map(([la,lo],i)=>{const[x,y]=proj(la,lo);return(i===0?"M":"L")+x+","+y;}).join(" ");
    return `<path d="${d}" stroke="#3B82F6" stroke-width="2" fill="none" opacity="0.6" stroke-linecap="round"/>`;
  }).join("");

  const rPx=Math.round((200/69)/latSpan*H);
  const[cx,cy]=proj(clat,clon);
  const dots=threats.filter(t=>t.lat&&t.lon).slice(0,25).map(t=>{
    const[x,y]=proj(t.lat,t.lon);
    if(x<-10||x>W+10||y<-10||y>H+10) return "";
    const col=t.riskScore>=70?"#B91C1C":t.riskScore>=45?"#D97706":"#CA8A04";
    return `<circle cx="${x}" cy="${y}" r="${t.riskScore>=70?7:5}" fill="${col}" stroke="white" stroke-width="1.5" opacity="0.9"/>`;
  }).join("");

  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="#F5F0E8"/>
    ${grid}${corridors}
    <circle cx="${cx}" cy="${cy}" r="${rPx}" stroke="#B91C1C" stroke-width="1.5" stroke-dasharray="8,4" fill="#B91C1C" fill-opacity="0.05"/>
    ${dots}${cities}
    <circle cx="${cx}" cy="${cy}" r="11" fill="#0071CE" stroke="white" stroke-width="2.5"/>
    <text x="${cx}" y="${cy+4}" text-anchor="middle" font-size="9" font-weight="bold" fill="white" font-family="sans-serif">${target.store??""}</text>
    <rect x="4" y="${H-20}" width="240" height="16" rx="3" fill="white" fill-opacity="0.8"/>
    <circle cx="13" cy="${H-12}" r="4" fill="#B91C1C"/>
    <text x="20" y="${H-8}" font-size="7" fill="#374151" font-family="sans-serif">High risk</text>
    <circle cx="58" cy="${H-12}" r="4" fill="#D97706"/>
    <text x="65" y="${H-8}" font-size="7" fill="#374151" font-family="sans-serif">Medium</text>
    <circle cx="103" cy="${H-12}" r="4" fill="#CA8A04"/>
    <text x="110" y="${H-8}" font-size="7" fill="#374151" font-family="sans-serif">Low</text>
    <circle cx="145" cy="${H-12}" r="4" fill="#0071CE"/>
    <text x="152" y="${H-8}" font-size="7" fill="#374151" font-family="sans-serif">Your store</text>
    <line x1="188" y1="${H-12}" x2="205" y2="${H-12}" stroke="#3B82F6" stroke-width="2"/>
    <text x="208" y="${H-8}" font-size="7" fill="#374151" font-family="sans-serif">Interstate</text>
  </svg>`;
  return "data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg);
}
