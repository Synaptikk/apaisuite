// modules/safetyagent/lib/camteams.js
//
// Which team each camera's alert goes to first. Store Systems keeps it in a
// SharePoint list on teams.wal-mart.com (one row per store camera, ~18k rows
// across the wave; "Title" = store number and is indexed, so filtering on it
// stays under the 5,000-item list threshold). Columns used:
//   Camera_x0020_NAME        — matches SafeIQ camera_name exactly (160/160 at 1458)
//   Supercenter_x0020_Team   — "Responsible Team" (Seasonal, Front End, ...)
//   InScope                  — "Include in Safety Agent" Yes/No
// The SW fetches it with the user's SharePoint cookies (host permission on
// teams.wal-mart.com); nothing to sign in to beyond their normal Office SSO.

export const CAMLIST_SITE = "https://teams.wal-mart.com/sites/StoreSystemsIDC";
export const CAMLIST_PATH = "/sites/StoreSystemsIDC/Lists/Wave3SouthEastBU4_ListWithChoices_202606041905";

export function camListUrl(store) {
  const nbr = Number(store);
  if (!Number.isInteger(nbr) || nbr <= 0) throw new Error(`camListUrl: bad store "${store}"`);
  const sel = ["Camera_x0020_NAME", "Supercenter_x0020_Team", "InScope", "Final_x0020_Focal_x0020_Area"].join(",");
  return `${CAMLIST_SITE}/_api/web/GetList('${CAMLIST_PATH}')/items` +
    `?$top=5000&$filter=Title eq '${nbr}'&$select=${sel}`;
}

/** SharePoint items → { cameraName: { team, area, inScope } }. Pure. */
export function parseCamList(json) {
  const out = {};
  for (const r of json?.value || []) {
    const cam = String(r.Camera_x0020_NAME || "").trim();
    if (!cam) continue;
    out[cam] = {
      team: String(r.Supercenter_x0020_Team || "").trim() || null,
      area: String(r.Final_x0020_Focal_x0020_Area || "").trim() || null,
      inScope: String(r.InScope || "").toLowerCase() !== "no",
    };
  }
  return out;
}
