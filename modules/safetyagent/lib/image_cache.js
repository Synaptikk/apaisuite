export const IMAGE_SCHEMA = 2;

export function needsImageRefresh(data) {
  return !!data && data.schema !== IMAGE_SCHEMA &&
    Array.isArray(data.rows) && data.rows.some(row => row.length < 13);
}

// Keep the old dashboard usable if authentication or the refresh fails.
// Preserve the cached query window, not the view's current display filters.
export async function upgradeImageCache(data, refresh) {
  if (!needsImageRefresh(data)) return { data };
  try {
    const result = await refresh({ store: data.store, from: data.from || null, to: data.to || null });
    if (!result?.data) throw new Error(result?.error || "No refreshed alerts returned");
    return { data: result.data };
  } catch {
    return { data, imageRefreshError: "Could not refresh older alerts with image IDs. Open SafeIQ to check sign-in, then use Pull alerts to retry." };
  }
}
