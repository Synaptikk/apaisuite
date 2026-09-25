// modules/sparkrisk/lib/rebuild.js
//
// Deterministic full rebuild of the SparkRisk analysis from order history.
//
// Every import replays ALL retained orders, so session identity and driver
// baselines never depend on the order imports arrived in. Reviews are carried
// across by matching the OLD session's order-id set against the new sessions;
// anything that cannot be matched to exactly one session is archived rather
// than deleted, and duplicates are preserved verbatim in `merged_reviews`.

import { buildSessionsFromOrders, scoreSessions } from './sessions.js';

export const storeOf = o => String(o.store_nbr || o.store_id || o.store || '');
export const orderKey = o => JSON.stringify([storeOf(o), String(o.order_id)]);
const ids = s => { try { return JSON.parse(s.order_ids || '[]').map(String); } catch { return []; } };
const sameSet = (a, b) => a.length === b.length && a.every(id => b.includes(id));

export async function rebuild(oldOrders, incoming, oldSessions = [], oldReviews = []) {
  const ordersById = new Map();
  let rejected = 0;
  for (const raw of [...oldOrders, ...incoming]) {
    if (!raw || raw.order_id == null || !String(raw.order_id).trim()) { rejected++; continue; }
    const order = { ...raw, order_id: String(raw.order_id) };
    delete order.id; // IndexedDB's old auto-increment key is not order identity.
    order.id = orderKey(order);
    ordersById.set(order.id, order);
  }
  const orders = [...ordersById.values()];
  const sessions = scoreSessions(await buildSessionsFromOrders(orders), {});
  const targets = new Map(sessions.map(s => [s.session_id, s]));

  // Legacy session → new session. An EXACT order-id set match wins outright.
  // A subset match is accepted only when it is the single candidate, so a
  // legacy single-order session can never be attached to an arbitrary trip
  // that happens to contain that order alongside others.
  const redirect = new Map();
  for (const old of oldSessions) {
    const oldIds = ids(old);
    if (!oldIds.length) continue;
    const sameStore = s => !old.store || String(old.store) === s.store;
    const exact = sessions.filter(s => sameStore(s) && sameSet(oldIds, ids(s)));
    const candidates = exact.length ? exact
      : sessions.filter(s => sameStore(s) && oldIds.every(id => ids(s).includes(id)));
    if (candidates.length === 1) redirect.set(old.session_id, { to: candidates[0].session_id, how: exact.length ? 'exact' : 'subset' });
  }

  const grouped = new Map();
  const reviews = [];
  for (const review of oldReviews) {
    const hop = targets.has(review.session_id)
      ? { to: review.session_id, how: 'same-id' }
      : redirect.get(review.session_id);
    // Unmatched legacy reviews are kept, never dropped. `session_id` is
    // namespaced so an archived row can never collide with a live review or
    // be joined onto a live session by session_id.
    if (!hop) { reviews.push({ ...review, archived: true, original_session_id: review.session_id, session_id: `archived:${review.id ?? review.session_id}` }); continue; }
    if (!grouped.has(hop.to)) grouped.set(hop.to, []);
    grouped.get(hop.to).push({ review, how: hop.how });
  }

  for (const s of sessions) {
    const hops = (grouped.get(s.session_id) || [])
      .sort((a, b) => String(b.review.updated_at || b.review.created_at || '').localeCompare(String(a.review.updated_at || a.review.created_at || '')));
    const prior = hops.map(x => x.review);
    const pick = hops.find(x => x.review.status !== 'new' || x.review.notes) || hops[0];
    const chosen = pick?.review;
    const how = pick?.how;
    reviews.push({
      ...(chosen || { id: `review:${s.session_id}`, status: 'new', notes: '', created_at: new Date().toISOString() }),
      session_id: s.session_id, archived: false,
      priority: s.priority_score >= 75 ? 1 : s.priority_score >= 60 ? 2 : 3,
      ...(chosen && how && how !== 'same-id' ? { migrated_by: how, original_session_id: chosen.session_id } : {}),
      // Preserve every merged review verbatim, including conflicting decisions.
      ...(prior.length > 1 ? { merged_reviews: prior } : {}),
    });
  }

  const eligibleOrders = new Set(sessions.flatMap(s => ids(s).map(id => JSON.stringify([s.store, id]))));
  return { orders, sessions, reviews, rejected, ineligibleOrders: orders.filter(o => !eligibleOrders.has(orderKey(o))).length };
}
