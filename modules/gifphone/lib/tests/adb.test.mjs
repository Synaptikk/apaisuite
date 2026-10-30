import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AdbDevice, CMD, parseHeader, parseBanner } from "../adb.js";
import { generateAdbKey } from "../adb_key.js";

const enc = new TextEncoder(), dec = new TextDecoder();

// A pretend phone on the other end of the transport.
function fakePhone({ knowsKey, maxData = 4096 }) {
  const out = [];                       // chunks the host will read
  const waiters = [];
  let pendingHdr = null;
  const phone = { prompts: 0, installed: null, key: null, streams: new Map() };
  const push = (cmd, a0, a1, data = new Uint8Array(0)) => {
    const h = new DataView(new ArrayBuffer(24));
    h.setUint32(0, cmd, true); h.setUint32(4, a0, true); h.setUint32(8, a1, true);
    h.setUint32(12, data.length, true); h.setUint32(20, (cmd ^ 0xffffffff) >>> 0, true);
    out.push(new Uint8Array(h.buffer)); if (data.length) out.push(data);
    while (waiters.length && out.length) waiters.shift()(out.shift());
  };
  const token = crypto.randomBytes(20);
  let nextRemote = 100;
  function onMessage(m, data) {
    if (m.cmd === CMD.CNXN) return push(CMD.AUTH, 1, 0, new Uint8Array(token));
    if (m.cmd === CMD.AUTH && m.arg0 === 2) {
      if (knowsKey) return push(CMD.CNXN, 0x01000001, maxData, enc.encode("device::ro.product.model=SM-S928U;ro.product.device=e3q;\0"));
      return push(CMD.AUTH, 1, 0, new Uint8Array(token));
    }
    if (m.cmd === CMD.AUTH && m.arg0 === 3) {
      phone.prompts++; phone.key = dec.decode(data);
      return push(CMD.CNXN, 0x01000001, maxData, enc.encode("device::ro.product.model=SM-S928U;\0"));
    }
    if (m.cmd === CMD.OPEN) {
      const svc = dec.decode(data).replace(/\0$/, "");
      const id = nextRemote++;
      const st = { local: m.arg0, svc, got: 0, size: Number((svc.match(/-S (\d+)/) || [])[1] || 0) };
      phone.streams.set(id, st);
      push(CMD.OKAY, id, m.arg0);
      if (!st.size) {
        push(CMD.WRTE, id, m.arg0, enc.encode(svc.includes("echo") ? "hi\n" : "?\n"));
      }
      return;
    }
    if (m.cmd === CMD.WRTE) {
      const st = phone.streams.get(m.arg1);
      st.got += data.length;
      assert.ok(data.length <= maxData, "host respected maxData");
      push(CMD.OKAY, m.arg1, m.arg0);
      if (st.got === st.size) { phone.installed = st.got; push(CMD.WRTE, m.arg1, st.local, enc.encode("Success\n")); }
      return;
    }
    if (m.cmd === CMD.OKAY) {
      const st = phone.streams.get(m.arg1);
      if (st && !st.closed) { st.closed = true; push(CMD.CLSE, m.arg1, st.local); }
      return;
    }
  }
  const transport = {
    async write(bytes) {
      if (!pendingHdr) {
        const h = parseHeader(bytes);
        if (h.length) { pendingHdr = h; return; }
        onMessage(h, new Uint8Array(0));
      } else {
        const h = pendingHdr; pendingHdr = null;
        assert.equal(bytes.length, h.length);
        onMessage(h, bytes);
      }
    },
    async read(len) {
      const c = out.length ? out.shift() : await new Promise((r) => waiters.push(r));
      assert.ok(c.length <= len, "host asked for at least the chunk size");
      return c;
    },
    async close() {},
  };
  return { transport, phone };
}

test("first connect offers the public key and prompts once", async () => {
  const key = await generateAdbKey();
  const { transport, phone } = fakePhone({ knowsKey: false });
  const adb = new AdbDevice(transport);
  let prompted = 0;
  const banner = await adb.connect(key, { onPrompt: () => prompted++ });
  assert.equal(prompted, 1);
  assert.equal(phone.prompts, 1);
  assert.match(phone.key, / APAISuite@browser\0$/);
  assert.equal(parseBanner(banner).model, "SM-S928U");
});

test("known key connects by signature, runs shell, installs an APK in chunks", async () => {
  const key = await generateAdbKey();
  const { transport, phone } = fakePhone({ knowsKey: true, maxData: 4096 });
  const adb = new AdbDevice(transport);
  let prompted = 0;
  await adb.connect(key, { onPrompt: () => prompted++ });
  assert.equal(prompted, 0);
  assert.equal(await adb.shell("echo hi"), "hi");
  const apk = crypto.randomBytes(10_000);
  const marks = [];
  const res = await adb.install(new Uint8Array(apk), { onProgress: (f) => marks.push(f) });
  assert.equal(res, "Success");
  assert.equal(phone.installed, 10_000);
  assert.equal(marks.length, 3);
  assert.equal(marks.at(-1), 1);
});
