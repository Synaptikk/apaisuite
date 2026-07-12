// Item — normalized OMS order-line row.
//
// Source: raw OMS provider-oms/orders payload[] row (notes/api_endpoints.md:88-94).
// Each OMS row is one item line, not one order — multiple items per order
// appear as multiple rows with the same orderNo.
//
// Normalizations:
//   - quantity / unitPriceUsd cast to Number (raw is sometimes string)
//   - isCancelled precomputed from lineStatus.toLowerCase() === "cancelled"
//     (currently the only line-status enum consumed — see enums.json#lineStatuses)

export function toItem(omsRow) {
  if (!omsRow || typeof omsRow !== "object") omsRow = {};
  const lineStatus = omsRow.lineStatus || null;
  return {
    id:           omsRow.itemId   || null,
    name:         omsRow.itemName || null,
    upc:          omsRow.upc      || null,
    sku:          omsRow.sku || omsRow.wupc || null,
    quantity:     omsRow.quantity  != null ? Number(omsRow.quantity)  : null,
    unitPriceUsd: omsRow.unitPrice != null ? Number(omsRow.unitPrice) : null,
    lineStatus,
    isCancelled:  (lineStatus || "").toLowerCase() === "cancelled",
  };
}
