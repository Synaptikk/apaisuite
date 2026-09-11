import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

test("late store responses cannot replace the selected store's classifications or attribution", async () => {
  const source = readFileSync(new URL("../../view.js", import.meta.url), "utf8");
  const start = source.indexOf("  let weeksRequest = 0;");
  const end = source.indexOf("  async function loadWeek()", start);
  const pending = new Map();
  const state = { store: "1458" };
  let loads = 0;
  const context = vm.createContext({
    state, setStatus() {},
    call(type, { store }) {
      return new Promise((resolve) => pending.set(`${store}:${type}`, resolve));
    },
    $: () => ({}), host: { ui: { escapeHtml: String } },
    weekLabel: String, loadWeek: async () => { loads++; },
  });
  vm.runInContext(source.slice(start, end), context);
  const first = vm.runInContext("loadWeeks()", context);
  state.store = "5151";
  const second = vm.runInContext("loadWeeks()", context);
  function finish(store) {
    pending.get(`${store}:get_classifications`)({ store });
    pending.get(`${store}:get_classification_editor`)({ label: store });
    pending.get(`${store}:list_weeks`)([]);
  }
  finish("5151"); await second;
  finish("1458"); await first;
  assert.equal(state.classifications.store, "5151");
  assert.equal(state.classificationEditor.label, "5151");
  assert.equal(loads, 1);
});
