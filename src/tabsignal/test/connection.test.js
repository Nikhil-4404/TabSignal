import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { release } from "../extension/release.js";

test("companion setup checks readiness without publishing and fails closed on old or incompatible helpers", async t => {
  const listener = () => ({ addListener(fn) { this.callback = fn; } });
  const ports = [];
  const messages = [];
  const timeouts = [];
  let settings = { enabled: false, clientId: "", sites: ["example.com"], siteOptions: { "example.com": { media: false } } };
  const tab = { id: 1, url: "https://example.com/", title: "Example", incognito: false };
  const realInterval = globalThis.setInterval;
  const realTimeout = globalThis.setTimeout;
  globalThis.setInterval = (fn, ms) => realInterval(fn, ms).unref();
  globalThis.setTimeout = (fn, ms) => { if (ms === 5000) timeouts.push(fn); return realTimeout(fn, ms); };
  globalThis.chrome = {
    runtime: { id: "a".repeat(32), getURL: name => `chrome-extension://${"a".repeat(32)}/${name}`,
      connectNative() {
        const port = { onMessage: listener(), onDisconnect: listener(), disconnected: false,
          postMessage(message) { messages.push(message); },
          disconnect() { this.disconnected = true; this.onDisconnect.callback(); } };
        ports.push(port); return port;
      }, onMessage: listener(), onInstalled: listener(), onStartup: listener() },
    storage: { local: { async get() { return settings; }, async set(value) { settings = value; } }, onChanged: listener() },
    windows: { async getLastFocused() { return { id: 1 }; }, onFocusChanged: listener(), onRemoved: listener() },
    tabs: { async query() { return [{ ...tab }]; }, onActivated: listener(), onUpdated: listener(), onRemoved: listener() },
    action: { async setBadgeText() {} }, alarms: { async create() {}, onAlarm: listener() },
    permissions: { async contains() { return false; }, onAdded: listener(), onRemoved: listener() }
  };
  t.after(() => {
    ports.at(-1)?.disconnect();
    globalThis.setInterval = realInterval;
    globalThis.setTimeout = realTimeout;
    delete globalThis.chrome;
  });
  await import("../extension/background.js");
  const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") };
  const get = message => new Promise(resolve => chrome.runtime.onMessage.callback(message, sender, resolve));
  const ready = { status: "Helper ready. Waiting for an allowed page.", connectionState: "ready",
    protocolVersion: release.protocolVersion, helperVersion: release.version };
  await delay(160);
  assert.equal(ports.length, 0, "Sharing off must not start a helper until setup is checked");
  let view = await get({ type: "view" });
  assert.equal(view.connectionState, "connecting");
  assert.equal(view.helperReady, false);
  assert.deepEqual(messages, []);
  ports[0].onMessage.callback({ status: "Helper ready." });
  assert.equal(ports[0].disconnected, true);
  view = await get({ type: "view" });
  assert.equal(view.connectionState, "incompatible");
  assert.equal(ports.length, 1, "Polling must respect retry backoff");
  settings = { ...settings, enabled: true };
  await get({ type: "retry" });
  const current = ports.at(-1);
  assert.deepEqual(messages, [], "No activity may cross the native port before a valid handshake");
  current.onMessage.callback(ready);
  await delay(160);
  assert.equal(messages.at(-1).type, "activity");
  assert.equal(messages.at(-1).clientId, release.applicationId);
  view = await get({ type: "view" });
  assert.equal(view.helperReady, true);
  assert.equal(view.connectionState, "ready", "Helper readiness must not imply Discord success");
  ports[0].onMessage.callback({ ...ready, status: "Obsolete state", connectionState: "shared" });
  assert.notEqual((await get({ type: "view" })).connectionState, "shared");
  current.onMessage.callback({ ...ready, status: "Cannot connect to Discord.", connectionState: "discord-unavailable" });
  assert.equal((await get({ type: "view" })).helperReady, true);
  assert.equal((await get({ type: "view" })).connectionState, "discord-unavailable");
  current.onMessage.callback({ ...ready, status: "Shared on Discord.", connectionState: "shared" });
  assert.equal((await get({ type: "view" })).connectionState, "shared");
  await get({ type: "save", settings: { ...settings, enabled: false } });
  assert.deepEqual(messages.at(-1), { type: "clear" });
  assert.equal((await get({ type: "save" })).error !== undefined, true, "Malformed settings must not reset saved state");
  await get({ type: "retry" });
  ports.at(-1).onMessage.callback({ ...ready, protocolVersion: release.protocolVersion + 1 });
  assert.equal((await get({ type: "view" })).connectionState, "incompatible");
  await get({ type: "retry" });
  timeouts.at(-1)();
  assert.equal((await get({ type: "view" })).connectionState, "incompatible", "Silent old helpers must time out without receiving activity");
});
