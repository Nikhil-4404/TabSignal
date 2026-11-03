import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { validateMessage, discordActivity } from "../native/bridge.js";

test("worker keeps allowed activity on focus loss and clears on privacy changes or window closure", async t => {
  const listener = () => ({ addListener(fn) { this.callback = fn; } });
  let settings = { enabled: true, clientId: "123456789012345678", sites: ["example.com"] };
  let focused = true;
  let windowOpen = true;
  let mediaAccess = false;
  let playerAccess = false;
  let injections = [];
  let permissionChecks = 0;
  let tab = { id: 1, url: "https://example.com/private?secret=value", title: "Public title", incognito: false };
  const extraOrigins = new Set();
  const playback = () => ({ position: 30, duration: 120, paused: false, rate: 1, observedAt: Date.now() });
  let topReport = { title: "Real media title", service: "Example TV", subtitle: "Series name",
    artworkUrl: "https://cdn.example.com/cover.jpg", embedFrames: ["https://player.example.com/embed?token=secret"] };
  let frameReports = new Map([[3, { playback: { ...playback(), paused: true } }]]);
  let frameTree = [{ frameId: 3, parentFrameId: 0, url: "https://player.example.com/embed?token=secret" },
    { frameId: 4, parentFrameId: 0, url: "https://player.example.com/hidden-ad" }];
  let navigationFailure = false;
  let navigationReads = 0;
  let connections = 0;
  let disconnections = 0;
  const nativePorts = [];
  let replacementDocumentId = null;
  let topFrameOverride = null;
  let onPermission = null;
  let onInjection = null;
  let onTopLookup = null;
  const frames = () => [{ frameId: 0, parentFrameId: -1, documentId: "top-document", url: tab?.url, ...topFrameOverride },
    ...frameTree.map(frame => ({ documentId: `player-document-${frame.frameId}`, ...frame }))];
  const injectedFrames = () => injections.map(target => target.documentIds[0] === "top-document" ? 0 :
    Number(/player-document-(\d+)$/.exec(target.documentIds[0])?.[1]));
  const messages = [];
  const createNative = () => ({ onMessage: { addListener(fn) { this.callback = fn;
    queueMicrotask(() => fn({ protocolVersion: 1, helperVersion: "0.4.0", connectionState: "ready", status: "Companion ready." })); } },
    onDisconnect: listener(), postMessage(value) { messages.push(value); },
    disconnect() { disconnections++; this.onDisconnect.callback(); } });
  globalThis.chrome = {
    runtime: { id: "a".repeat(32), getURL: name => `chrome-extension://${"a".repeat(32)}/${name}`,
      connectNative: () => { connections++; const native = createNative(); nativePorts.push(native); return native; }, onMessage: listener(), onInstalled: listener(), onStartup: listener() },
    storage: { local: { async get() { return settings; }, async set(value) { settings = value; } }, onChanged: listener() },
    windows: { async getLastFocused() { if (!windowOpen) throw new Error("No windows"); return { id: 1, focused }; }, onFocusChanged: listener(), onRemoved: listener() },
    tabs: { async query() { return tab ? [{ ...tab }] : []; }, onActivated: listener(), onUpdated: listener(), onRemoved: listener() },
    action: { async setBadgeText() {} }, alarms: { async create() {}, onAlarm: listener() },
    permissions: { async contains(value) {
      permissionChecks++;
      onPermission?.();
      if (value.origins[0] === "https://player.example.com/*") {
        if (replacementDocumentId) frameTree = frameTree.map(frame => frame.frameId === 3 ? { ...frame, documentId: replacementDocumentId } : frame);
        return playerAccess;
      }
      return value.origins[0] === "https://example.com/*" ? mediaAccess : extraOrigins.has(value.origins[0]); },
      onAdded: listener(), onRemoved: listener() },
    scripting: { async executeScript({ target, args }) {
      injections.push(target);
      onInjection?.();
      const document = frames().find(frame => target.documentIds?.includes(frame.documentId));
      if (!document) throw new Error("Document navigated before injection");
      assert.deepEqual(args, [document.url]);
      return [{ frameId: document.frameId, documentId: document.documentId,
        result: { pageUrl: document.url, ...(document.frameId === 0 ? topReport : frameReports.get(document.frameId)) } }];
    } },
    webNavigation: { async getFrame() { onTopLookup?.(); return frames()[0]; },
      async getAllFrames() { navigationReads++; if (navigationFailure) throw new Error("Frame lookup unavailable");
        return frames(); } }
  };
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  t.after(() => { globalThis.setInterval = realInterval; delete globalThis.chrome; });
  await import("../extension/background.js");
  const trigger = async () => { chrome.windows.onFocusChanged.callback(); await delay(160); };
  const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") };
  const get = message => new Promise(resolve => chrome.runtime.onMessage.callback(message, sender, resolve));
  await delay(300);
  assert.deepEqual(messages.at(-1), { type: "activity", clientId: settings.clientId,
    activity: { host: "example.com", title: "Public title", iconUrl: "https://icons.bitwarden.net/example.com/icon.png", mode: "browsing" } });
  tab = { ...tab, favIconUrl: "https://example.com/site.png" };
  chrome.tabs.onUpdated.callback(tab.id, { favIconUrl: tab.favIconUrl });
  await delay(160);
  assert.equal(messages.at(-1).activity.iconUrl, "https://icons.bitwarden.net/example.com/icon.png");
  tab = { ...tab, favIconUrl: "" };
  chrome.tabs.onUpdated.callback(tab.id, { favIconUrl: "" });
  await delay(160);
  assert.equal(messages.at(-1).activity.iconUrl, "https://icons.bitwarden.net/example.com/icon.png");
  focused = false;
  await trigger();
  assert.equal(messages.at(-1).type, "activity");
  assert.equal(messages.at(-1).activity.title, "Public title");
  tab = { ...tab, title: "Next episode" };
  await trigger();
  assert.equal(messages.at(-1).activity.title, "Next episode");
  tab = { ...tab, url: "https://example.com/watch/16" };
  await trigger();
  assert.equal(messages.at(-1).activity.mode, "watching");
  mediaAccess = true;
  await trigger();
  assert.equal(messages.at(-1).activity.media.title, "Real media title");
  assert.equal(messages.at(-1).activity.media.playback, undefined);
  assert(injectedFrames().every(frameId => frameId === 0), "Unpermitted player was read");
  playerAccess = true;
  injections = [];
  await trigger();
  assert.equal(messages.at(-1).activity.media.playback.paused, true);
  assert.deepEqual(injectedFrames(), [0, 3]);
  const originalTop = topReport;
  const originalReports = frameReports;
  const originalFrames = frameTree;
  const inspect = async () => { injections = []; await get({ type: "retry" }); await delay(160); return get({ type: "view" }); };
  await t.test("Retry replaces an existing native connection so updated helper files can load", async () => {
    const before = { connections, disconnections };
    const previous = nativePorts.at(-1);
    await inspect();
    assert.equal(connections, before.connections + 1);
    assert.equal(disconnections, before.disconnections + 1);
    assert.equal(messages.at(-1).type, "activity");
    previous.onDisconnect.callback();
    assert.equal((await get({ type: "view" })).connection, "Companion ready.", "Late disconnect from old helper replaced new status");
  });
  await t.test("committed unlisted navigation is rejected before injection even when its tab event is delayed", async () => {
    const approvedTab = tab;
    onPermission = () => {
      onPermission = null;
      tab = { ...tab, url: "https://unlisted.example.com/private", title: "SYNTHETIC_PRIVATE_TITLE" };
      topFrameOverride = { documentId: "new-unlisted-document", url: tab.url };
    };
    assert.equal((await inspect()).activity, null);
    assert.deepEqual(messages.at(-1), { type: "clear" });
    assert.deepEqual(injections, [], "An unlisted document was injected using a stale allowed tab");
    assert(!JSON.stringify(messages).includes("SYNTHETIC_PRIVATE_TITLE"));
    tab = approvedTab;
    topFrameOverride = null;
  });
  await t.test("top injection stays pinned when the frame navigates after its document lookup", async () => {
    onInjection = () => { onInjection = null; topFrameOverride = { documentId: "replacement-top-document" }; };
    assert.equal((await inspect()).activity, null);
    assert.deepEqual(injections, [{ tabId: tab.id, documentIds: ["top-document"] }]);
    assert.deepEqual(messages.at(-1), { type: "clear" });
    topFrameOverride = null;
  });
  await t.test("another page URL in a top reader result is rejected at the background boundary", async () => {
    topReport = { ...originalTop, pageUrl: "https://unlisted.example.com/private", title: "SYNTHETIC_PRIVATE_TITLE" };
    assert.equal((await inspect()).activity, null);
    assert.deepEqual(messages.at(-1), { type: "clear" });
    assert(!JSON.stringify(messages).includes("SYNTHETIC_PRIVATE_TITLE"));
    topReport = originalTop;
  });
  await t.test("a replacement top document after nested reads clears the entire stale activity", async () => {
    let lookups = 0;
    onTopLookup = () => { if (++lookups === 2) topFrameOverride = { documentId: "replacement-top-document" }; };
    assert.equal((await inspect()).activity, null);
    assert.deepEqual(messages.at(-1), { type: "clear" });
    onTopLookup = null;
    topFrameOverride = null;
  });
  await t.test("sharing disabled during a read is enforced before publication without a storage event", async () => {
    const approvedSettings = settings;
    onInjection = () => { onInjection = null; settings = { ...settings, enabled: false }; };
    assert.equal((await inspect()).activity, null);
    assert.deepEqual(messages.at(-1), { type: "clear" });
    settings = approvedSettings;
  });
  await t.test("changed presentation permissions during a read prevent stale artwork and timing publication", async () => {
    const approvedSettings = settings;
    onInjection = () => { onInjection = null; settings = { ...settings, siteOptions: { "example.com": { artwork: false, progress: false } } }; };
    assert.equal((await inspect()).activity, null);
    assert.deepEqual(messages.at(-1), { type: "clear" });
    settings = approvedSettings;
  });
  await t.test("direct-page playback does not depend on iframe discovery", async () => {
    topReport = { ...originalTop, playback: playback() };
    navigationFailure = true;
    const reads = navigationReads;
    const next = await inspect();
    assert.equal(next.activity.media.playback.position, 30);
    assert.equal(navigationReads, reads);
    assert.deepEqual(injectedFrames(), [0]);
    assert.equal(discordActivity(validateMessage(messages.at(-1)).activity).timestamps.end -
      discordActivity(validateMessage(messages.at(-1)).activity).timestamps.start, 120);
    topReport = originalTop;
    const metadataOnly = await inspect();
    assert.equal(metadataOnly.activity.media.title, "Real media title");
    assert.equal(metadataOnly.activity.media.playback, undefined);
    navigationFailure = false;
  });
  await t.test("nested players require each exact origin and preserve top-page metadata", async () => {
    topReport = originalTop;
    frameTree = [...originalFrames, { frameId: 7, parentFrameId: 3, url: "https://stream.example.net/video/16" }];
    frameReports = new Map([[3, { title: "Wrapper title", embedFrames: ["https://stream.example.net/video/16"] }],
      [7, { title: "Player title", playback: playback() }]]);
    let next = await inspect();
    assert.equal(next.mediaRequest, "https://stream.example.net/*");
    assert.equal(next.activity.media.playback, undefined);
    assert.deepEqual(injectedFrames(), [0, 3]);
    extraOrigins.add("https://stream.example.net/*");
    next = await inspect();
    assert.equal(next.activity.media.playback.position, 30);
    assert.equal(next.activity.media.title, "Real media title");
    assert.equal(next.activity.media.service, "Example TV");
    assert.equal(next.mediaRequest, null);
    assert.deepEqual(injectedFrames(), [0, 3, 7]);
    const rpc = discordActivity(validateMessage(messages.at(-1)).activity);
    assert.equal(rpc.timestamps.end - rpc.timestamps.start, 120);
    assert(!JSON.stringify(rpc).includes("secret"));
    extraOrigins.clear();
    next = await inspect();
    assert.equal(next.activity.media.playback, undefined, "Revoked nested permission retained timing");
    assert.deepEqual(injectedFrames(), [0, 3]);
  });
  await t.test("redirects, hidden siblings and duplicate sources stay unread", async () => {
    topReport = originalTop;
    frameReports = new Map([[3, { playback: playback() }]]);
    frameTree = [{ frameId: 3, parentFrameId: 0, url: "https://player.example.com/redirected" }];
    assert.equal((await inspect()).activity.media.playback, undefined);
    assert.deepEqual(injectedFrames(), [0]);
    frameTree.push(originalFrames[1]);
    assert.equal((await inspect()).activity.media.playback, undefined);
    assert.deepEqual(injectedFrames(), [0]);
    frameTree = [originalFrames[0]];
    topReport = { ...originalTop, embedFrames: [...originalTop.embedFrames, ...originalTop.embedFrames] };
    assert.equal((await inspect()).activity.media.playback, undefined);
    assert.deepEqual(injectedFrames(), [0]);
    topReport = originalTop;
    frameTree.push({ ...originalFrames[0], frameId: 8 });
    assert.equal((await inspect()).activity.media.playback, undefined);
    assert.deepEqual(injectedFrames(), [0]);
  });
  await t.test("cross-origin redirects and frames outside the reported parent stay unread", async () => {
    frameTree = [{ frameId: 3, parentFrameId: 0, url: "https://stream.example.net/redirected" }, originalFrames[1]];
    frameReports = new Map([[3, { playback: playback() }], [4, { playback: playback() }]]);
    extraOrigins.add("https://stream.example.net/*");
    assert.equal((await inspect()).activity.media.playback, undefined);
    assert.deepEqual(injectedFrames(), [0]);
    frameTree = [{ ...originalFrames[0], parentFrameId: 99 }];
    assert.equal((await inspect()).activity.media.playback, undefined);
    assert.deepEqual(injectedFrames(), [0]);
    extraOrigins.clear();
  });
  await t.test("child injection uses document IDs and never falls back after document navigation", async () => {
    frameTree = [{ ...originalFrames[0], documentId: "player-document-before-navigation" }];
    frameReports = new Map([[3, { playback: playback() }]]);
    assert.equal((await inspect()).activity.media.playback.position, 30);
    assert.deepEqual(injections, [{ tabId: tab.id, documentIds: ["top-document"] },
      { tabId: tab.id, documentIds: ["player-document-before-navigation"] }]);
    replacementDocumentId = "replacement-document";
    assert.equal((await inspect()).activity.media.playback, undefined);
    assert.deepEqual(injections, [{ tabId: tab.id, documentIds: ["top-document"] },
      { tabId: tab.id, documentIds: ["player-document-before-navigation"] }]);
    replacementDocumentId = null;
  });
  await t.test("missing document IDs fail closed instead of reading whichever document has the frame ID", async () => {
    topFrameOverride = { documentId: undefined };
    assert.equal((await inspect()).activity, null);
    assert.deepEqual(injections, []);
    topFrameOverride = null;
    frameTree = [{ ...originalFrames[0], documentId: undefined }];
    assert.equal((await inspect()).activity.media.playback, undefined);
    assert.deepEqual(injectedFrames(), [0]);
  });
  await t.test("a player result from another URL cannot contribute playback or nested frames", async () => {
    frameTree = originalFrames;
    frameReports = new Map([[3, { pageUrl: "https://player.example.com/hidden-ad", playback: playback(),
      embedFrames: ["https://stream.example.net/private"] }]]);
    const next = await inspect();
    assert.equal(next.activity.media.playback, undefined);
    assert.equal(next.mediaRequest, null);
    assert.deepEqual(injectedFrames(), [0, 3]);
  });
  await t.test("nested traversal stops at four player levels", async () => {
    topReport = { ...originalTop, embedFrames: ["https://player.example.com/embed/1"] };
    frameTree = Array.from({ length: 5 }, (_, index) => ({ frameId: index + 1, parentFrameId: index,
      url: `https://player.example.com/embed/${index + 1}` }));
    frameReports = new Map(frameTree.map(frame => [frame.frameId, frame.frameId === 5 ? { playback: playback() } :
      { embedFrames: [`https://player.example.com/embed/${frame.frameId + 1}`] }]));
    assert.equal((await inspect()).activity.media.playback, undefined);
    assert.deepEqual(injectedFrames(), [0, 1, 2, 3, 4]);
  });
  await t.test("nested traversal inspects no more than 32 child frames", async () => {
    frameTree = Array.from({ length: 48 }, (_, index) => ({ frameId: index + 1, parentFrameId: index < 16 ? 0 : index - 15,
      url: `https://player.example.com/embed/${index + 1}` }));
    topReport = { ...originalTop, embedFrames: frameTree.slice(0, 16).map(frame => frame.url) };
    frameReports = new Map(frameTree.map(frame => [frame.frameId, frame.frameId > 32 ? { playback: playback() } :
      { embedFrames: [`https://player.example.com/embed/${frame.frameId + 16}`] }]));
    assert.equal((await inspect()).activity.media.playback, undefined);
    assert.deepEqual(injectedFrames(), Array.from({ length: 33 }, (_, index) => index));
  });
  topReport = originalTop;
  frameReports = originalReports;
  frameTree = originalFrames;
  settings = { ...settings, siteOptions: { "example.com": { artwork: false, progress: false, links: false } } };
  await trigger();
  assert.equal(messages.at(-1).activity.iconUrl, undefined);
  assert.equal(messages.at(-1).activity.media.artworkUrl, undefined);
  assert.equal(messages.at(-1).activity.media.playback, undefined);
  assert.equal(messages.at(-1).activity.media.pageUrl, undefined);
  assert.deepEqual(messages.at(-1).activity.presentation, { artwork: false, progress: false, links: false });
  settings = { ...settings, siteOptions: { "example.com": { media: false } } };
  const inspectionsBefore = injections.length;
  const checksBefore = permissionChecks;
  await trigger();
  assert.equal(messages.at(-1).activity.media, undefined);
  assert.equal(injections.length, inspectionsBefore, "Disabling media must prevent page/player reads");
  assert.equal(permissionChecks, checksBefore, "Disabling media must not check or request media access");
  assert.equal((await get({ type: "view" })).mediaRequest, null);
  settings = { ...settings, siteOptions: { "example.com": { enabled: false } } };
  await trigger();
  assert.deepEqual(messages.at(-1), { type: "clear" });
  const paused = await get({ type: "view" });
  assert.equal(paused.host, "example.com");
  assert.equal(paused.reason, "Sharing is paused for this website.");
  assert.equal(injections.length, inspectionsBefore, "Paused websites must not be inspected");
  settings = { ...settings, siteOptions: {} };
  mediaAccess = false;
  await trigger();
  assert.equal(messages.at(-1).activity.media, undefined, "Revoked access must remove stale metadata");
  tab = { ...tab, url: "https://example.com/home" };
  await trigger();
  assert.equal(messages.at(-1).activity.mode, "browsing");
  focused = true;
  tab = { ...tab, incognito: true };
  await trigger();
  assert.deepEqual(messages.at(-1), { type: "clear" });
  const injectedBefore = injections.length;
  tab = { ...tab, incognito: false, url: "https://unlisted.com" };
  await trigger();
  assert.deepEqual(messages.at(-1), { type: "clear" });
  assert.equal(injections.length, injectedBefore, "Private or unlisted pages must not be inspected");
  settings = { ...settings, enabled: false };
  tab = { ...tab, url: "https://example.com/watch" };
  await trigger();
  assert.deepEqual(messages.at(-1), { type: "clear" });
  settings = { ...settings, enabled: true, sites: [] };
  await trigger();
  assert.deepEqual(messages.at(-1), { type: "clear" });
  settings = { ...settings, sites: ["example.com"] };
  await trigger();
  assert.equal(messages.at(-1).type, "activity");
  tab = undefined;
  await trigger();
  assert.deepEqual(messages.at(-1), { type: "clear" });
  windowOpen = false;
  await trigger();
  assert.deepEqual(messages.at(-1), { type: "clear" });
  assert(!JSON.stringify(messages).includes("secret"));
  const rejected = await get({ type: "save", settings: { ...settings, clientId: "bad" } });
  assert.match(rejected.error, /Application ID/);
  assert.equal(chrome.runtime.onMessage.callback({ type: "save" }, { ...sender, tab: {} }, () => assert.fail("Untrusted sender accepted")), undefined);
});
