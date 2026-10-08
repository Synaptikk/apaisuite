// shared/moduleGroups.js
//
// Sidebar + home-card grouping. Each module tags itself with
// `manifest.group: "<id>"`; this table decides the label, the order the
// groups render in, and the faint tint each group carries. A module with no
// group (or an unknown one) lands in "Other" at the bottom so a missing tag
// never hides a module.
//
// Tints are mixed down hard in CSS (see .shell-nav-group / .module-card),
// so these are full-strength hues, not the final on-screen colour.

export const MODULE_GROUPS = Object.freeze([
  { id: "ap",           label: "Asset Protection", tint: "#D64545" },
  { id: "frontend",     label: "Front End",        tint: "#3B82F6" },
  { id: "safety",       label: "Safety",           tint: "#E8A317" },
  { id: "digital",      label: "Digital",          tint: "#8B5CF6" },
  { id: "storeops",     label: "Store Ops",        tint: "#22A06B" },
  { id: "market",       label: "Market & Exec",    tint: "#0EA5A5" },
  { id: "integrations", label: "Integrations",     tint: "#8792A2" },
]);

export const OTHER_GROUP = Object.freeze({ id: "other", label: "Other", tint: "#8792A2" });

const BY_ID = new Map(MODULE_GROUPS.map((g) => [g.id, g]));

export function groupOf(mod) {
  return BY_ID.get(mod?.manifest?.group) ?? OTHER_GROUP;
}

// Partition an already-ordered module list into [{ group, modules }] in
// MODULE_GROUPS order. Order within a group is the input order, so the
// user's saved drag order still applies inside each group. Empty groups
// are dropped.
export function groupModules(modules) {
  const buckets = new Map();
  for (const mod of modules) {
    const g = groupOf(mod);
    if (!buckets.has(g.id)) buckets.set(g.id, []);
    buckets.get(g.id).push(mod);
  }
  return [...MODULE_GROUPS, OTHER_GROUP]
    .filter((g) => buckets.has(g.id))
    .map((g) => ({ group: g, modules: buckets.get(g.id) }));
}
