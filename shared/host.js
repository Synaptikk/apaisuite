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
    shell:     Object.freeze({ ...shellApi }),
  });
}
