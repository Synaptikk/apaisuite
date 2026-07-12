// modules/digitallocks/lib/buildCaseMap.js
//
// Two entry points for "Create Locking Case Map":
//
//   fetchAllLocksFromPage — async function serialized into the user's active
//     InVue /app/locks tab via chrome.scripting.executeScript (world: MAIN).
//     Runs same-origin, so the InVue API fetch is allowed without CORS issues.
//     Paginates automatically through all locks.  Must be self-contained.
//
//   buildCaseMapXlsx(locks) — called in the shell page after the SW returns
//     the lock array.  Builds a valid .xlsx Blob using a minimal OOXML writer
//     (uncompressed ZIP of XML parts — no third-party deps, no deflate).

// ── Page-injected scraper ─────────────────────────────────────────────────────
//
// Chrome serializes this function when passed to executeScript({ func: ... }).
// ALL helpers must be declared inside the function body — no module-scope refs.

export async function fetchAllLocksFromPage() {
  const BASE     = window.location.origin;
  const LOCK_URL = BASE + "/appv1/locks";
  const CNT_URL  = BASE + "/appv1/locks/reports/count";
  const HDRS     = { "Content-Type": "application/json", Accept: "application/json" };

  // ── Discover InVue-internal store_id ────────────────────────────────────────
  // InVue uses a numeric store_id (e.g. 3773) that differs from the Walmart
  // store number.  Read it from the React fiber tree or Web Storage before
  // sending it in the request body.  Omitting it falls back to session auth.

  function walkFiber(fiber, depth) {
    if (!fiber || depth > 500) return null;
    let s = fiber.memoizedState;
    while (s) {
      const ms = s.memoizedState;
      if (ms && typeof ms === "object" && !Array.isArray(ms)) {
        const sid = ms.store_id ?? ms.storeId ?? ms?.auth?.store_id ?? ms?.user?.store_id;
        if (typeof sid === "number") return sid;
      }
      s = s.next;
    }
    const p = fiber.memoizedProps;
    if (p && typeof p === "object") {
      const sid = p.store_id ?? p.storeId ?? p?.value?.store_id ?? p?.value?.storeId;
      if (typeof sid === "number") return sid;
    }
    return walkFiber(fiber.child, depth + 1) || walkFiber(fiber.sibling, depth + 1);
  }

  function discoverStoreId() {
    const root = document.getElementById("root");
    if (root) {
      const fk = Object.keys(root).find((k) => k.startsWith("__reactFiber"));
      if (fk) {
        const found = walkFiber(root[fk], 0);
        if (found) return found;
      }
    }
    for (const store of [localStorage, sessionStorage]) {
      for (const k of Object.keys(store)) {
        try {
          const v = JSON.parse(store.getItem(k));
          const sid = v?.store_id ?? v?.storeId ?? v?.user?.store_id;
          if (typeof sid === "number") return sid;
        } catch { /* non-JSON, skip */ }
      }
    }
    return null;
  }

  // ── API wrappers ─────────────────────────────────────────────────────────────

  async function apiFetch(url, bodyObj) {
    const r = await fetch(url, { method: "POST", headers: HDRS, body: JSON.stringify(bodyObj) });
    if (!r.ok) throw new Error(`InVue API ${url}: HTTP ${r.status}`);
    return r.json();
  }

  async function getCount(storeId) {
    const d = await apiFetch(CNT_URL, {
      method: "get", endpoint: "locks/reports/count", body: null,
      params: { q: "", ...(storeId != null ? { store_id: storeId } : {}) },
    });
    return parseInt(d.count, 10) || 0;
  }

  async function getPage(storeId, offset, count) {
    return apiFetch(LOCK_URL, {
      method: "get", endpoint: "locks", body: null,
      params: {
        offset, count, q: "",
        data: {
          excludeLock: ["createdAt", "tintkyalf_id", "ir3-operator", "Store"],
          Zone: ["id", "name"],
        },
        ...(storeId != null ? { store_id: storeId } : {}),
      },
    });
  }

  // ── Paginate ─────────────────────────────────────────────────────────────────

  const storeId = discoverStoreId();
  const total   = await getCount(storeId);
  if (total === 0) return [];

  const PAGE = 100;
  const all  = [];
  for (let offset = 0; offset < total; offset += PAGE) {
    const page = await getPage(storeId, offset, PAGE);
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return all;
}

// ── XLSX builder ──────────────────────────────────────────────────────────────

const COLS = [
  { key: "name",                label: "Lock Name"     },
  { key: "Zone.name",           label: "Zone"          },
  { key: "status",              label: "Status"        },
  { key: "latchStatus",         label: "Latch"         },
  { key: "batteryHealthStatus", label: "Battery %"     },
  { key: "fwVersion",           label: "Firmware"      },
  { key: "dualAuthEnabled",     label: "Dual Auth"     },
  { key: "description",         label: "Notes"         },
  { key: "serialNumber",        label: "Serial Number" },
];

export function buildCaseMapXlsx(locks) {
  const headers = COLS.map((c) => c.label);
  const rows = locks.map((lock) =>
    COLS.map(({ key }) => {
      if (key === "Zone.name")       return lock.Zone?.name ?? "";
      if (key === "dualAuthEnabled") return lock.dualAuthEnabled ? "Yes" : "No";
      const v = lock[key];
      return v == null ? "" : String(v);
    })
  );

  const parts = {
    "[Content_Types].xml":           xmlContentTypes(),
    "_rels/.rels":                   xmlRels(),
    "xl/workbook.xml":               xmlWorkbook(),
    "xl/_rels/workbook.xml.rels":    xmlWorkbookRels(),
    "xl/styles.xml":                 xmlStyles(),
    "xl/worksheets/sheet1.xml":      xmlSheet(headers, rows),
  };

  return new Blob([buildStoredZip(parts)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// ── Sheet XML ─────────────────────────────────────────────────────────────────

function xmlSheet(headers, dataRows) {
  const allRows = [headers, ...dataRows];

  const colWidths = headers.map((h, ci) => {
    const max = Math.max(h.length, ...dataRows.map((r) => String(r[ci] ?? "").length));
    return Math.min(50, Math.max(10, max + 2));
  });

  const colDefs = colWidths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" bestFit="1" customWidth="1"/>`)
    .join("");

  const rowXmls = allRows.map((row, ri) => {
    const isHeader = ri === 0;
    const cells = row.map((val, ci) => {
      const ref = `${colLetter(ci)}${ri + 1}`;
      const s   = isHeader ? ` s="1"` : "";
      return `<c r="${ref}" t="inlineStr"${s}><is><t>${xmlEsc(String(val ?? ""))}</t></is></c>`;
    });
    return `<row r="${ri + 1}">${cells.join("")}</row>`;
  });

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView tabSelected="1" workbookViewId="0">` +
    `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `</sheetView></sheetViews>` +
    `<cols>${colDefs}</cols>` +
    `<sheetData>${rowXmls.join("")}</sheetData>` +
    `</worksheet>`
  );
}

function colLetter(i) {
  let s = "", n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function xmlEsc(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  }[c]));
}

// ── OOXML parts ───────────────────────────────────────────────────────────────

function xmlContentTypes() {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`
  );
}

function xmlRels() {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`
  );
}

function xmlWorkbook() {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Case Map" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`
  );
}

function xmlWorkbookRels() {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`
  );
}

function xmlStyles() {
  // Style index 0 = normal, index 1 = bold (used for header row via s="1").
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="2">` +
    `<font><sz val="11"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
    `</fonts>` +
    `<fills count="2">` +
    `<fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill>` +
    `</fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="2">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `</cellXfs>` +
    `</styleSheet>`
  );
}

// ── Minimal ZIP writer (stored, no compression) ───────────────────────────────
//
// OOXML files are ZIP archives.  Using stored (method=0) entries avoids a
// deflate dependency.  All entries here are small XML strings, so the overhead
// of uncompressed storage is negligible.

function buildStoredZip(members) {
  const enc   = new TextEncoder();
  const files = Object.entries(members).map(([name, content]) => {
    const nameBytes = enc.encode(name);
    const data      = enc.encode(content);
    return { nameBytes, data, crc: crc32(data) };
  });

  // Pre-compute local-header offsets for the central directory.
  let offset = 0;
  const offsets = files.map(({ nameBytes, data }) => {
    const o = offset;
    offset += 30 + nameBytes.length + data.length;
    return o;
  });

  const cdSize  = files.reduce((s, { nameBytes }) => s + 46 + nameBytes.length, 0);
  const cdStart = offset;
  const total   = cdStart + cdSize + 22;

  const buf = new Uint8Array(total);
  const dv  = new DataView(buf.buffer);
  let   pos = 0;

  // DOS timestamp 1980-01-01 00:00 (the ZIP epoch minimum).
  const dosTime = 0x0000;
  const dosDate = 0x0021;

  // Local file headers + data
  for (let i = 0; i < files.length; i++) {
    const { nameBytes, data, crc } = files[i];
    const sz = data.length;
    dv.setUint32(pos,      0x04034b50, true); // LFH signature
    dv.setUint16(pos + 4,  20,         true); // version needed
    dv.setUint16(pos + 6,  0,          true); // flags
    dv.setUint16(pos + 8,  0,          true); // method: stored
    dv.setUint16(pos + 10, dosTime,    true);
    dv.setUint16(pos + 12, dosDate,    true);
    dv.setUint32(pos + 14, crc,        true);
    dv.setUint32(pos + 18, sz,         true); // compressed = uncompressed
    dv.setUint32(pos + 22, sz,         true);
    dv.setUint16(pos + 26, nameBytes.length, true);
    dv.setUint16(pos + 28, 0,          true); // extra length
    buf.set(nameBytes, pos + 30);
    buf.set(data,      pos + 30 + nameBytes.length);
    pos += 30 + nameBytes.length + sz;
  }

  // Central directory entries
  for (let i = 0; i < files.length; i++) {
    const { nameBytes, data, crc } = files[i];
    const sz = data.length;
    dv.setUint32(pos,      0x02014b50, true); // CDH signature
    dv.setUint16(pos + 4,  20,         true); // version made by
    dv.setUint16(pos + 6,  20,         true); // version needed
    dv.setUint16(pos + 8,  0,          true); // flags
    dv.setUint16(pos + 10, 0,          true); // method: stored
    dv.setUint16(pos + 12, dosTime,    true);
    dv.setUint16(pos + 14, dosDate,    true);
    dv.setUint32(pos + 16, crc,        true);
    dv.setUint32(pos + 20, sz,         true);
    dv.setUint32(pos + 24, sz,         true);
    dv.setUint16(pos + 28, nameBytes.length, true);
    dv.setUint16(pos + 30, 0, true); // extra
    dv.setUint16(pos + 32, 0, true); // comment
    dv.setUint16(pos + 34, 0, true); // disk start
    dv.setUint16(pos + 36, 0, true); // internal attrs
    dv.setUint32(pos + 38, 0, true); // external attrs
    dv.setUint32(pos + 42, offsets[i], true); // local header offset
    buf.set(nameBytes, pos + 46);
    pos += 46 + nameBytes.length;
  }

  // End of central directory record
  dv.setUint32(pos,      0x06054b50,    true); // EOCD signature
  dv.setUint16(pos + 4,  0,             true); // disk number
  dv.setUint16(pos + 6,  0,             true); // disk with CD start
  dv.setUint16(pos + 8,  files.length,  true); // entries on disk
  dv.setUint16(pos + 10, files.length,  true); // total entries
  dv.setUint32(pos + 12, pos - cdStart, true); // CD size
  dv.setUint32(pos + 16, cdStart,       true); // CD offset
  dv.setUint16(pos + 20, 0,             true); // comment length

  return buf;
}

// ── CRC-32 (ZIP/OOXML requires it for each stored entry) ─────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
