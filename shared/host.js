// shared/host.js
//
// The `host` API surface — every module receives one of these.
// See docs/ARCHITECTURE.md::3.4 The `host` API surface.
//
// Modules use `host.*` instead of `chrome.*` so that:
//   1. storage keys are auto-namespaced
//   2. messages are auto-routed to the right module handler
//   3. shared platform behavior (re-injection fallback, retry, sanitization)
//      is consistent across modules

import { createStorage }   from "./storage.js";
import { createMessaging } from "./messaging.js";
import { createTabs }      from "./tabs.js";
import { createAuth }      from "./auth.js";
import { createHttp }      from "./http.js";
import { createLogging }   from "./logging.js";
import { createUI }        from "./ui.js";
import { recordUsage }     from "./usage_metrics.js";

export function createHost(moduleId, shellApi = {}) {
  if (!moduleId) throw new Error("createHost: moduleId required");
  return Object.freeze({
    id:        moduleId,
    // Resolve a path relative to this module's folder to a fully-qualified
    // chrome-extension:// URL. Use this for fetching view.html, loading
    // module-local assets, etc. — never hardcode "modules/<id>/..." paths
    // inside a module so renaming a module is a one-step operation.
    url: (path) => chrome.runtime.getURL(`modules/${moduleId}/${path}`),
    storage:   createStorage(moduleId),
    messaging: createMessaging(moduleId),
    tabs:      createTabs(moduleId),
    auth:      createAuth(moduleId),
    http:      createHttp(moduleId),
    logging:   createLogging(moduleId),
    ui:        createUI(moduleId),
    // Suite-wide usage telemetry. `moduleName` is filled in from the host, so
    // a module cannot record usage against another module's name, and every
    // call site is one line:
    //
    //     host.usage.record("collect_pressed");
    //
    // Call it at the point of INTENT (the click), not on completion — put the
    // outcome in `result`. A module that fails often should read as used and
    // broken, not as unused.
    //
    // Fire-and-forget: it swallows its own errors, because telemetry that can
    // fail a user action is worse than no telemetry.
    usage: Object.freeze({
      record: (actionName, opts = {}) =>
        recordUsage({ ...opts, moduleName: moduleId, actionName }).catch(() => {}),
    }),
    shell:     Object.freeze({ ...shellApi }),
  });
}
