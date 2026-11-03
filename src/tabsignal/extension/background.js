import { defaults, settingsFor, activityFor, tabHost, validateSettings, permissionOrigin, mediaDetails, sitePreferences, applyPresentation } from "./activity.js";
import { readMedia } from "./media.js";
import { release } from "./release.js";

let port = null;
let revision = 0;
let timer;
let nextConnect = 0;
let helperReady = false;
let handshakeTimer;
let state = { connection: "Open connection setup to check the companion.", connectionState: "unchecked", helperVersion: null,
  activity: null, host: null, reason: "Sharing is off." };

async function inspectMedia(tab) {
  const origin = permissionOrigin(tab.url);
  const access = { permissions: ["scripting", "webNavigation"], origins: origin ? [origin] : [] };
  if (!origin || !await chrome.permissions.contains(access)) return { media: null, mediaRequest: origin, mediaAccess: false };
  try {
    const document = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
    if (!document?.documentId || document.errorOccurred || document.url !== tab.url) {
      return { media: null, mediaRequest: null, mediaAccess: true, documentChanged: true };
    }
    const [top] = await chrome.scripting.executeScript({ target: { tabId: tab.id, documentIds: [document.documentId] },
      func: readMedia, args: [document.url] });
    if (top?.documentId !== document.documentId || top.result?.pageUrl !== document.url) {
      return { media: null, mediaRequest: null, mediaAccess: true, documentChanged: true };
    }
    const host = tabHost(tab);
    let playback = mediaDetails(top?.result, host)?.playback;
    let mediaRequest = null;
    if (!playback) {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => []);
      const queue = [{ frameId: 0, report: top?.result, depth: 0 }];
      const visited = new Set([0]);
      for (const parent of queue) {
        if (playback || parent.depth >= 4) continue;
        const sources = (parent.report?.embedFrames || []).slice(0, 16);
        const children = (frames || []).filter(frame => frame.parentFrameId === parent.frameId && !frame.errorOccurred);
        for (const frame of children.slice(0, 32)) {
          if (playback || visited.size >= 33) break;
          if (visited.has(frame.frameId)) continue;
          const frameOrigin = permissionOrigin(frame.url);
          if (!frame.documentId || !frameOrigin || sources.filter(source => source === frame.url).length !== 1 ||
              children.filter(child => child.url === frame.url).length !== 1) continue;
          visited.add(frame.frameId);
          if (await chrome.permissions.contains({ origins: [frameOrigin] })) {
            try {
              const target = { tabId: tab.id, documentIds: [frame.documentId] };
              const [result] = await chrome.scripting.executeScript({ target, func: readMedia, args: [frame.url] });
              if (result?.documentId !== frame.documentId || result.result?.pageUrl !== frame.url) continue;
              playback = mediaDetails(result?.result, host)?.playback;
              queue.push({ frameId: frame.frameId, report: result?.result, depth: parent.depth + 1 });
            } catch { /* A navigated or blocked player does not replace the page preview. */ }
          } else mediaRequest ||= frameOrigin;
        }
      }
    }
    const latest = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
    if (latest?.documentId !== document.documentId || latest.url !== document.url || latest.errorOccurred) {
      return { media: null, mediaRequest: null, mediaAccess: true, documentChanged: true };
    }
    return { media: mediaDetails({ ...top.result, ...(playback ? { playback } : {}) }, host),
      mediaRequest: playback ? null : mediaRequest, mediaAccess: true };
  } catch {
    return { media: null, mediaRequest: null, mediaAccess: true, documentChanged: true };
  }
}

function connect() {
  if (port || Date.now() < nextConnect) return port;
  try {
    const current = chrome.runtime.connectNative("app.tabsignal.bridge");
    port = current;
    helperReady = false;
    state.helperVersion = null;
    state.connection = "Checking the Windows companion…";
    state.connectionState = "connecting";
    const incompatible = () => {
      if (port !== current) return;
      clearTimeout(handshakeTimer);
      port = null;
      helperReady = false;
      nextConnect = Date.now() + 10000;
      state.connection = "Update the Windows companion, then reconnect.";
      state.connectionState = "incompatible";
      current.disconnect();
    };
    handshakeTimer = setTimeout(incompatible, 5000);
    current.onMessage.addListener(message => {
      if (port !== current) return;
      if (message?.protocolVersion !== release.protocolVersion || typeof message.helperVersion !== "string" ||
          !/^\d+\.\d+\.\d+$/.test(message.helperVersion) || typeof message.status !== "string" || message.status.length > 256 ||
          !["ready", "updating", "shared", "discord-unavailable", "hidden", "error"].includes(message.connectionState)) {
        incompatible();
        return;
      }
      clearTimeout(handshakeTimer);
      const first = !helperReady;
      helperReady = true;
      state.helperVersion = message.helperVersion;
      state.connection = message.status;
      state.connectionState = message.connectionState;
      if (first) schedule();
    });
    current.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      if (port !== current) return;
      clearTimeout(handshakeTimer);
      port = null;
      helperReady = false;
      nextConnect = Date.now() + 10000;
      state.connection = `Companion unavailable. Run setup, then reconnect.${error?.message ? ` ${error.message.slice(0, 180)}` : ""}`;
      state.connectionState = "unavailable";
    });
  } catch {
    state.connection = "The Windows companion could not be started. Run setup, then reconnect.";
    state.connectionState = "unavailable";
    nextConnect = Date.now() + 10000;
  }
  return port;
}

async function refresh() {
  const current = ++revision;
  try {
    const settings = settingsFor(await chrome.storage.local.get(defaults));
    const window = await chrome.windows.getLastFocused();
    const [tab] = await chrome.tabs.query({ active: true, windowId: window.id });
    if (current !== revision) return;
    const preferences = sitePreferences(settings, tabHost(tab));
    let activity = activityFor(tab, settings);
    const details = activity && preferences.media ? await inspectMedia(tab) : { media: null, mediaRequest: null, mediaAccess: false };
    if (current !== revision) return;
    const latestWindow = await chrome.windows.getLastFocused();
    const [latestTab] = await chrome.tabs.query({ active: true, windowId: latestWindow.id });
    const latestSettings = settingsFor(await chrome.storage.local.get(defaults));
    if (current !== revision) return;
    // Navigation and settings events can arrive after the asynchronous page read.
    if (details.documentChanged || latestWindow.id !== window.id || latestTab?.id !== tab?.id ||
        latestTab?.url !== tab?.url || latestTab?.title !== tab?.title || latestTab?.incognito !== tab?.incognito ||
        !activityFor(latestTab, latestSettings) || latestSettings.clientId !== settings.clientId ||
        JSON.stringify(sitePreferences(latestSettings, tabHost(latestTab))) !== JSON.stringify(preferences)) activity = null;
    if (activity && details.media) {
      if (details.media.playback) activity.mode = "watching";
      if (activity.mode === "watching") activity = { ...activity, media: details.media };
    }
    if (activity) activity = applyPresentation(activity, preferences);
    state.activity = activity;
    state.mediaRequest = details.mediaRequest;
    state.mediaAccess = details.mediaAccess;
    state.host = tabHost(tab);
    state.reason = !settings.enabled ? "Sharing is off." : !settings.clientId ? "Add an Application ID." :
      !state.host ? "This page stays private." :
      !settings.sites.includes(state.host) ? "This site is not allowed yet." :
      !preferences.enabled ? "Sharing is paused for this website." : "This website is allowed.";
    await chrome.action.setBadgeText({ text: activity ? "ON" : "" });
    if (current !== revision) return;
    if (settings.enabled || port) {
      const helper = connect();
      if (helperReady) helper?.postMessage(activity ? { type: "activity", clientId: settings.clientId, activity } : { type: "clear" });
    }
  } catch (error) {
    if (current !== revision) return;
    state.activity = null;
    state.host = null;
    state.mediaRequest = null;
    state.mediaAccess = false;
    state.reason = "No readable browser window.";
    try { if (helperReady) port?.postMessage({ type: "clear" }); } catch { /* Disconnected ports already report their status. */ }
  }
}

function schedule() {
  ++revision;
  clearTimeout(timer);
  timer = setTimeout(refresh, 120);
}

chrome.tabs.onActivated.addListener(schedule);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || change.title || change.status || "favIconUrl" in change) schedule();
});
chrome.tabs.onRemoved.addListener(schedule);
chrome.windows.onFocusChanged.addListener(schedule);
chrome.windows.onRemoved.addListener(schedule);
chrome.storage.onChanged.addListener(schedule);
chrome.permissions.onAdded.addListener(schedule);
chrome.permissions.onRemoved.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create("refresh", { periodInMinutes: 0.5 });
  schedule();
});
chrome.alarms.onAlarm.addListener(schedule);
// A native port keeps the worker alive; the alarm also recovers after a disconnect.
setInterval(refresh, 5000);

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL("popup.html")) return;
  (async () => {
    if (message.type === "save") {
      const settings = validateSettings({ ...message.settings,
        clientId: message.settings?.clientId === "" ? release.applicationId : message.settings?.clientId });
      await chrome.storage.local.set(settings);
      await refresh();
    } else if (message.type === "retry") {
      const previous = port;
      port = null;
      helperReady = false;
      clearTimeout(handshakeTimer);
      nextConnect = 0;
      previous?.disconnect();
      connect();
      await refresh();
    } else if (message.type === "view") connect();
    else throw new Error("Unknown action.");
    return { ...state, helperReady, settings: settingsFor(await chrome.storage.local.get(defaults)) };
  })().then(respond, error => respond({ error: error.message }));
  return true;
});
schedule();
