// shared/sparkInvestigation/endpoints.js
//
// Centralized URL constants for the Spark investigation surface: Dispatcher
// (swift.walmart.com), Order Management (gscope OMS), Spark Dashboard MFE,
// and the pfedprod SAML SSO entry point.
//
// Historically these strings were duplicated across
// modules/sparkfraud/service.js (SWIFT_DASHBOARD_URL:34, SSO_START_URL:42,
// and inline literals at 486, 578, 738, 780) and
// modules/sparkfraud/view.js:24 (SWIFT_DASHBOARD dup) and view.js:1283
// (walmart.com/ip item link).
//
// Both SparkFraud and the future Spark & Scan&Go module consume these — a
// single registry keeps them in sync when Walmart moves an endpoint.
//
// Runtime-inert: nothing here does I/O. This module is safe to import
// from either SW or view contexts.

// Dispatcher API — trip/order/driver queries. Header-based auth built by
// shared/sparkInvestigation/auth.js from gscope session cookies.
export const SWIFT_DASHBOARD_URL = "https://swift.walmart.com/sparkApp/api/proxy/v4/dashboard";

// gscope MFE surfaces we drive to complete investigative lookups.
export const GSCOPE_ORIGIN            = "https://gscope.walmartlabs.com";
export const GSCOPE_SPARK_DASHBOARD   = `${GSCOPE_ORIGIN}/mfe/spark/dashboard`;
export const GSCOPE_ORDER_RESOLUTION  = `${GSCOPE_ORIGIN}/mfe/ordermanagement/orderresolution`;
export const GSCOPE_APPHOME           = `${GSCOPE_ORIGIN}/apphome`;
export const GSCOPE_OMS_ORDERS_PATH   = "/api/gateway/provider-oms/orders";

// SAML SSO entry that gscope's login page's "Sign in using Company SSO"
// button dispatches to. Reused by any module that needs to drive the SSO
// chain in a background tab.
export const SSO_START_URL = "https://pfedprod.wal-mart.com/idp/startSSO.ping?PartnerSpId=https://gscope.walmartlabs.com/sp";

// Public product detail page — used to look up item images by product ID.
export const walmartItemUrl = (itemId) => `https://www.walmart.com/ip/${encodeURIComponent(itemId ?? "")}`;
