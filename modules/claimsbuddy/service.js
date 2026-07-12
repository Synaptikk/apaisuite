// modules/claimsbuddy/service.js
//
// Service-worker handlers for ClaimsBuddy. Loaded statically by the SW
// dispatcher via module.js → registry.
//
// Currently empty — ClaimsBuddy's UI talks directly to chrome.storage,
// chrome.tabs, chrome.runtime.sendNativeMessage, and external HTTPS APIs
// from the view (it runs in the suite's full extension context). If we
// later need cross-tab capture, webRequest listeners, or alarm-driven
// polling, add the handlers here following the suite's handler pattern
// (see modules/sparkfraud/service.js for an example).

export const handlers = {};
