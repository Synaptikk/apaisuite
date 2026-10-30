// modules/gifphone/lib/adb.js
//
// Just enough of the adb wire protocol to set up a phone from a browser tab:
// connect + authenticate, run shell commands, stream an APK into
// `cmd package install`. No adb.exe, no drivers beyond what WebUSB needs.
//
// Protocol (system/core/adb/protocol.txt): 24-byte little-endian header
// { command, arg0, arg1, dataLength, dataCrc, magic = command ^ 0xffffffff }
// followed by the payload in its own transfer. Streams: OPEN → OKAY, then WRTE
// each answered by OKAY (one write in flight per stream), CLSE ends it.
//
// The transport is anything with write(bytes) / read(length) / close(), so the
// protocol is testable without a phone (tests/adb.test.mjs); usbTransport()
// below is the real one.

import { signToken, adbPublicKey } from "./adb_key.js";

const CMD = {
  SYNC: 0x434e5953, CNXN: 0x4e584e43, AUTH: 0x48545541, OPEN: 0x4e45504f,
  OKAY: 0x59414b4f, CLSE: 0x45534c43, WRTE: 0x45545257,
};
const NAME = Object.fromEntries(Object.entries(CMD).map(([k, v]) => [v, k]));
const AUTH_TOKEN = 1, AUTH_SIGNATURE = 2, AUTH_RSAPUBLICKEY = 3;
const VERSION = 0x01000001;          // ≥ this, the payload checksum may be 0
const HOST_MAX_DATA = 256 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const ADB_USB_FILTER = { classCode: 0xff, subclassCode: 0x42, protocolCode: 0x01 };

function header(cmd, arg0, arg1, data) {
  const h = new DataView(new ArrayBuffer(24));
  let sum = 0;
  for (const b of data) sum = (sum + b) >>> 0;
  h.setUint32(0, cmd, true);
  h.setUint32(4, arg0 >>> 0, true);
  h.setUint32(8, arg1 >>> 0, true);
  h.setUint32(12, data.length, true);
  h.setUint32(16, sum, true);
  h.setUint32(20, (cmd ^ 0xffffffff) >>> 0, true);
  return new Uint8Array(h.buffer);
}

export function parseHeader(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cmd = v.getUint32(0, true);
  if (bytes.byteLength < 24 || ((cmd ^ 0xffffffff) >>> 0) !== v.getUint32(20, true)) throw new Error("adb: bad message header");
  return { cmd, arg0: v.getUint32(4, true), arg1: v.getUint32(8, true), length: v.getUint32(12, true) };
}

const nul = (s) => enc.encode(s + "\0");

export class AdbDevice {
  constructor(transport) {
    this.t = transport;
    this.streams = new Map();      // localId → stream state
    this.nextId = 1;
    this.maxData = HOST_MAX_DATA;
    this.banner = "";
    this.closed = false;
    this.sendChain = Promise.resolve();
  }

  /** Send one message; header and payload are separate transfers. Serialized so two streams never interleave. */
  send(cmd, arg0, arg1, data = new Uint8Array(0)) {
    const run = async () => {
      await this.t.write(header(cmd, arg0, arg1, data));
      if (data.length) await this.t.write(data);
    };
    this.sendChain = this.sendChain.then(run, run);
    return this.sendChain;
  }

  async recv() {
    const h = parseHeader(await this.t.read(24));
    let data = new Uint8Array(0);
    if (h.length) {
      // a payload can arrive split across transfers; keep reading until whole
      data = new Uint8Array(h.length);
      let got = 0;
      while (got < h.length) {
        const part = await this.t.read(h.length - got);
        data.set(part, got); got += part.length;
      }
    }
    return { ...h, data };
  }

  /**
   * CNXN + AUTH. `key` = stored JWK (adb_key.js). onPrompt() fires when the
   * phone needs the user to tap "Allow USB debugging" (first connect).
   * Resolves with the device banner ("device::ro.product.model=…;…").
   */
  async connect(key, { onPrompt = () => {}, timeoutMs = 90_000 } = {}) {
    await this.send(CMD.CNXN, VERSION, HOST_MAX_DATA, nul("host::features=shell_v2,cmd,stat_v2,ls_v2,fixed_push_mkdir,apex,abb,abb_exec"));
    let signed = false;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const m = await withTimeout(this.recv(), deadline - Date.now(), "Phone didn't answer — tap Allow on the phone, then try again.");
      if (m.cmd === CMD.CNXN) {
        this.maxData = Math.min(m.arg1 || HOST_MAX_DATA, HOST_MAX_DATA);
        this.banner = dec.decode(m.data).replace(/\0+$/, "");
        this.pump();
        return this.banner;
      }
      if (m.cmd !== CMD.AUTH || m.arg0 !== AUTH_TOKEN) continue;
      if (!signed) {
        signed = true;
        await this.send(CMD.AUTH, AUTH_SIGNATURE, 0, signToken(key, m.data));
      } else {
        // phone didn't know our key: offer it and wait for the user to allow
        onPrompt();
        await this.send(CMD.AUTH, AUTH_RSAPUBLICKEY, 0, nul(adbPublicKey(key)));
      }
    }
  }

  /** Background reader: routes OKAY / WRTE / CLSE to their streams. */
  async pump() {
    try {
      while (!this.closed) {
        const m = await this.recv();
        const s = this.streams.get(m.arg1);
        if (!s) {
          if (m.cmd === CMD.WRTE) await this.send(CMD.CLSE, 0, m.arg0);
          continue;
        }
        if (m.cmd === CMD.OKAY) {
          s.remoteId = m.arg0;
          const w = s.waiting; s.waiting = null; w?.resolve();
        } else if (m.cmd === CMD.WRTE) {
          s.chunks.push(m.data);
          s.onData?.(m.data);
          await this.send(CMD.OKAY, s.localId, s.remoteId);
        } else if (m.cmd === CMD.CLSE) {
          this.streams.delete(s.localId);
          if (!s.closedByUs) await this.send(CMD.CLSE, s.localId, s.remoteId).catch(() => {});
          s.waiting?.reject(new Error("adb: stream closed by the phone"));
          s.done.resolve();
        }
      }
    } catch (e) {
      this.fail(e);
    }
  }

  fail(e) {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.streams.values()) { s.waiting?.reject(e); s.done.reject(e); }
    this.streams.clear();
  }

  /** Open a service ("exec:…", "shell:…"); resolves once the phone accepts it. */
  async open(service) {
    if (this.closed) throw new Error("adb: phone disconnected");
    const s = { localId: this.nextId++, remoteId: 0, chunks: [], waiting: deferred(), done: deferred(), closedByUs: false };
    s.done.promise.catch(() => {});
    this.streams.set(s.localId, s);
    const accepted = s.waiting.promise;   // grab it first: the OKAY can land before send() returns
    await this.send(CMD.OPEN, s.localId, 0, nul(service));
    await accepted;                       // first OKAY carries the remote id
    return s;
  }

  async write(s, bytes) {
    for (let off = 0; off < bytes.length; off += this.maxData) {
      s.waiting = deferred();
      const acked = s.waiting.promise;
      await this.send(CMD.WRTE, s.localId, s.remoteId, bytes.subarray(off, off + this.maxData));
      await acked;
    }
  }

  static text(s) {
    const total = s.chunks.reduce((a, c) => a + c.length, 0);
    const all = new Uint8Array(total);
    let o = 0;
    for (const c of s.chunks) { all.set(c, o); o += c.length; }
    return dec.decode(all);
  }

  /** Run a command, return its output (stdout + stderr). */
  async shell(command, { timeoutMs = 30_000 } = {}) {
    const s = await this.open(`exec:${command} 2>&1`);
    await withTimeout(s.done.promise, timeoutMs, `Timed out: ${command}`);
    return AdbDevice.text(s).trim();
  }

  /** Stream an APK into the package manager (personal profile). Returns pm's answer. */
  async install(apk, { user = 0, onProgress = () => {} } = {}) {
    const s = await this.open(`exec:cmd package install -r --user ${user} -S ${apk.length}`);
    for (let off = 0; off < apk.length; off += this.maxData) {
      await this.write(s, apk.subarray(off, off + this.maxData));
      onProgress(Math.min(1, (off + this.maxData) / apk.length));
    }
    await withTimeout(s.done.promise, 120_000, "Install timed out (the phone may be asking to confirm it)");
    return AdbDevice.text(s).trim();
  }

  async close() {
    this.closed = true;
    await this.t.close().catch(() => {});
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), Math.max(0, ms)); })])
    .finally(() => clearTimeout(t));
}

/** Banner "device::ro.product.model=SM-S928U;ro.product.name=…;" → { model, name, device }. */
export function parseBanner(banner) {
  const out = {};
  for (const part of banner.replace(/^[^:]*::/, "").split(";")) {
    const [k, v] = part.split("=");
    if (k && v) out[k.replace(/^ro\.product\./, "")] = v;
  }
  return out;
}

// ── WebUSB transport ─────────────────────────────────────────────────────────

/**
 * Open the phone's adb interface. Throws a readable error when another
 * program (adb.exe, Android Studio, the old GIF daemon) already holds it.
 */
export async function usbTransport(device) {
  await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  let iface, alt;
  for (const i of device.configuration.interfaces) {
    for (const a of i.alternates) {
      if (a.interfaceClass === ADB_USB_FILTER.classCode && a.interfaceSubclass === ADB_USB_FILTER.subclassCode
        && a.interfaceProtocol === ADB_USB_FILTER.protocolCode) { iface = i; alt = a; }
    }
  }
  if (!iface) throw new Error("This phone has no USB debugging interface — turn on USB debugging first.");
  try {
    await device.claimInterface(iface.interfaceNumber);
  } catch {
    throw new Error("Another program on this PC is using the phone (adb, Android Studio, or the old GIF daemon). Close it, unplug and replug the phone, then try again.");
  }
  if (alt.alternateSetting !== 0) await device.selectAlternateInterface(iface.interfaceNumber, alt.alternateSetting);
  const epIn = alt.endpoints.find((e) => e.direction === "in" && e.type === "bulk");
  const epOut = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
  const zlpMask = (epOut.packetSize || 512) - 1;
  return {
    async write(bytes) {
      const r = await device.transferOut(epOut.endpointNumber, bytes);
      if (r.status !== "ok") throw new Error(`USB write ${r.status}`);
      // a transfer that fills whole packets needs a zero-length packet to end it
      if (bytes.length && (bytes.length & zlpMask) === 0) await device.transferOut(epOut.endpointNumber, new Uint8Array(0));
    },
    async read(length) {
      const r = await device.transferIn(epIn.endpointNumber, length);
      if (r.status === "stall") { await device.clearHalt("in", epIn.endpointNumber); return this.read(length); }
      if (r.status !== "ok") throw new Error(`USB read ${r.status}`);
      return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    },
    async close() {
      await device.releaseInterface(iface.interfaceNumber).catch(() => {});
      await device.close().catch(() => {});
    },
  };
}

export { CMD, NAME };
