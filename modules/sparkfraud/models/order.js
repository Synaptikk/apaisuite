// Order — normalized order within a Trip.
//
// Source: raw Dispatcher response trip.orders[] (notes/api_endpoints.md:60-72).
// OMS rows merge in later via attachOmsItems().
//
// Customer field is REDACTED BY DEFAULT.
// Per docs/ARCHITECTURE.md data-safety rules: customer names, emails, and
// addresses are sensitive. order.customer carries only:
//   { firstNameInitial, addressRegion }
// To get the full customer record, call order.customer._full() — which
// future MODEL-* tasks should wire to emit a `redaction.expanded` telemetry
// event so accidental unredacted access is observable.

export function toOrder(raw) {
  if (!raw || typeof raw !== "object") raw = {};
  return {
    id:             raw.orderId || raw.id || null,
    dropNumber:     raw.dropNumber  ?? null,
    status:         raw.status         || null,
    externalStatus: raw.externalStatus || null,
    orderType:      raw.orderType      || null,
    storeId:        raw.storeId        ?? null,
    customerWindow: {
      startMs: raw.customerStartTime ? new Date(raw.customerStartTime).getTime() : null,
      endMs:   raw.customerEndTime   ? new Date(raw.customerEndTime).getTime()   : null,
    },
    taskEvents: (raw.taskEvents || [])
      .map(e => ({
        statusName: e.eventStatus || null,
        timeMs:     e.eventTime ? new Date(e.eventTime).getTime() : null,
      }))
      .filter(e => e.statusName && e.timeMs !== null),
    items: [],       // populated by attachOmsItems()
    customer: null,  // populated by attachOmsItems(); redacted by default
  };
}

// Mutates the orders[] array: attaches normalized Item[] and a redacted
// customer summary based on OMS rows keyed by order.id.
export function attachOmsItems(orders, omsRowsByOrderId, toItemFn) {
  for (const order of orders) {
    const rows = omsRowsByOrderId[order.id] || [];
    order.items = rows.map(toItemFn);
    if (rows.length) {
      const first = rows[0];
      order.customer = redactedCustomer(first);
    }
  }
}

function redactedCustomer(omsRow) {
  return {
    firstNameInitial: (omsRow.customerFirstName || "").charAt(0) || null,
    addressRegion: [omsRow.state, omsRow.postalCode].filter(Boolean).join(" ") || null,
    // Future MODEL-* should wrap this in a getter that emits redaction.expanded
    // telemetry. For now it's a plain accessor — do NOT log the returned object.
    _full() {
      return {
        firstName:  omsRow.customerFirstName || null,
        email:      omsRow.customerEmail     || null,
        address:    omsRow.shipToAddress     || null,
        city:       omsRow.city              || null,
        state:      omsRow.state             || null,
        postalCode: omsRow.postalCode        || null,
      };
    },
  };
}
