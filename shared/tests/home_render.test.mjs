import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
const render = source.slice(source.indexOf("let _renderHomePromise = null;"),
  source.indexOf("// Mount a module's view into an inline container"));

test("home rendering releases its lock without a header, including repeat renders", async () => {
  let paints = 0;
  const node = () => ({ style: {}, appendChild() {} });
  const context = vm.createContext({
    currentMount: null,
    $main: { innerHTML: "", appendChild() { paints++; } },
    document: { createElement: node },
    getSidebarModules: () => [],
    getHomeHeaderModule: () => null,
  });
  vm.runInContext(render, context);
  await vm.runInContext("renderHome()", context);
  // Check the lock before retrying: the broken version would starve timers.
  assert.equal(vm.runInContext("_renderHomePromise", context), null);
  await vm.runInContext("Promise.all([renderHome(), renderHome()])", context);
  assert.equal(vm.runInContext("_renderHomePromise", context), null);
  assert.equal(paints, 3);
});
