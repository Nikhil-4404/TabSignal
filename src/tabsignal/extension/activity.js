import { release } from "./release.js";

export const defaults = { enabled: false, clientId: release.applicationId, sites: [], siteOptions: {} };
export const validClientId = value => typeof value === "string" && /^[1-9]\d{16,19}$/.test(value);
const preferenceKeys = ["enabled", "media", "artwork", "progress", "links"];

export function settingsFor(value = {}) {
  return { ...defaults, ...value, clientId: release.channel === "public" || value.clientId === "" || value.clientId === undefined ? defaults.clientId : value.clientId };
}

export function sitePreferences(settings, host) {
  const options = settings.siteOptions?.[host];
  return Object.fromEntries(preferenceKeys.map(key => [key, typeof options?.[key] === "boolean" ? options[key] : true]));
}

export function applyPresentation(activity, options = {}) {
  const result = { ...activity };
  const presentation = Object.fromEntries(["artwork", "progress", "links"].map(key => [key, options[key] !== false]));
  if (!presentation.artwork) delete result.iconUrl;
  if (result.media) {
    result.media = { ...result.media };
    if (!presentation.artwork) delete result.media.artworkUrl;
    if (!presentation.progress) delete result.media.playback;
    if (!presentation.links) {
      delete result.media.pageUrl;
      delete result.media.secondaryUrl;
      delete result.media.secondaryLabel;
    }
  }
  if (Object.values(presentation).includes(false)) result.presentation = presentation;
  else delete result.presentation;
  return result;
}

export function publicHost(value) {
  if (typeof value !== "string" || value.length > 253) return null;
  const host = value.toLowerCase();
  // shortcut: reject literal IPs and local suffixes, add DNS checks if private network sharing is ever supported.
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
      /\.(?:localhost|local|localdomain|internal|lan|home|test|invalid|example)$/.test(host) || host.endsWith(".home.arpa")) return null;
  return host;
}

export function tabHost(tab) {
  if (!tab || tab.incognito) return null;
  try {
    const url = new URL(tab.url);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? publicHost(url.hostname) : null;
  } catch { return null; }
}

export function cleanTitle(value, fallback) {
  const title = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim() : "";
  return Array.from(title.length >= 2 ? title : fallback).slice(0, 128).join("");
}

export function publicImage(value) {
  try {
    if (typeof value !== "string" || value.length > 2048) throw new Error("Missing icon");
    const url = new URL(value);
    if (url.protocol !== "https:" || !publicHost(url.hostname) || url.username || url.password || url.port) throw new Error("Private icon");
    url.search = "";
    url.hash = "";
    if (url.href.length <= 300) return url.href;
  } catch { /* Only public HTTPS icons can be loaded by Discord. */ }
  return null;
}

export function siteIcon(host) {
  const domain = publicHost(host);
  // shortcut: icon availability depends on the provider's cache, revisit if a self-hosted icon service is needed.
  return domain ? `https://icons.bitwarden.net/${domain}/icon.png` : null;
}

export function serviceName(host) {
  const name = host.replace(/^www\./, "");
  return ({ "youtube.com": "YouTube", "m.youtube.com": "YouTube", "hianime.at": "HiAnime",
    "netflix.com": "Netflix", "disneyplus.com": "Disney+", "twitch.tv": "Twitch" })[name] || name.slice(0, 32);
}

export function permissionOrigin(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !publicHost(url.hostname) || url.username || url.password || url.port) return null;
    return `${url.origin}/*`;
  } catch { return null; }
}

export function publicLink(value, host) {
  try {
    if (typeof value !== "string" || value.length > 2048) return null;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== host || !publicHost(host) || url.username || url.password || url.port) return null;
    const video = /(^|\.)youtube\.com$/.test(host) && url.pathname === "/watch" ? url.searchParams.get("v") : null;
    const episode = host === "hianime.at" && url.pathname.startsWith("/watch/") ? url.searchParams.get("ep") : null;
    url.search = "";
    url.hash = "";
    if (video && /^[\w-]{6,64}$/.test(video)) url.searchParams.set("v", video);
    if (episode && /^\d{1,12}$/.test(episode)) url.searchParams.set("ep", episode);
    return url.href.length <= 512 ? url.href : null;
  } catch { return null; }
}

export function mediaDetails(value, host, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = { service: serviceName(host) };
  if (typeof value.title === "string" && value.title.trim()) result.title = cleanTitle(value.title, host);
  if (typeof value.service === "string" && value.service.trim()) result.service = Array.from(cleanTitle(value.service, host)).slice(0, 32).join("");
  if (typeof value.subtitle === "string" && value.subtitle.trim()) result.subtitle = cleanTitle(value.subtitle, host);
  const image = publicImage(value.artworkUrl);
  if (image) result.artworkUrl = image;
  const page = publicLink(value.pageUrl, host);
  if (page) result.pageUrl = page;
  const secondary = publicLink(value.secondaryUrl, host);
  if (secondary && secondary !== page) {
    result.secondaryUrl = secondary;
    result.secondaryLabel = /youtube\.com$/.test(host) ? "View Channel" : "View Series";
  }
  const p = value.playback;
  if (p && Number.isFinite(p.duration) && p.duration > 0 && p.duration <= 604800 &&
      Number.isFinite(p.position) && p.position >= 0 && p.position <= p.duration &&
      typeof p.paused === "boolean" && Number.isFinite(p.rate) && p.rate >= 0.1 && p.rate <= 16 &&
      Number.isFinite(p.observedAt) && Math.abs(now - p.observedAt) <= 90000) {
    result.playback = { position: p.position, duration: p.duration,
      paused: p.paused, rate: p.rate, observedAt: Math.round(p.observedAt) };
  }
  return result;
}

export function activityFor(tab, settings) {
  const host = tabHost(tab);
  if (!settings.enabled || !validClientId(settings.clientId) ||
      !host || !settings.sites.includes(host) || !sitePreferences(settings, host).enabled) return null;
  // shortcut: infer watching from video-page paths, add player adapters when playback/paused state is needed.
  const watching = /(?:^|\/)(?:watch|shorts|embed|episode|episodes|video|videos)(?:\/|$)/i.test(new URL(tab.url).pathname);
  return applyPresentation({ host, title: cleanTitle(tab.title, host), iconUrl: siteIcon(host), mode: watching ? "watching" : "browsing" }, sitePreferences(settings, host));
}

export function validateSettings(value) {
  if (release.channel === "public" && value?.clientId !== release.applicationId) throw new Error("TabSignal's application is managed by this release.");
  if (!value || typeof value.enabled !== "boolean" ||
      (value.clientId !== "" && !validClientId(value.clientId)) ||
      !Array.isArray(value.sites) || value.sites.length > 200 ||
      value.sites.some(site => typeof site !== "string" || publicHost(site) !== site)) throw new Error("Check the Application ID and allowed sites.");
  if (value.enabled && !validClientId(value.clientId)) throw new Error("Save your Discord Application ID first.");
  const options = value.siteOptions === undefined ? {} : value.siteOptions;
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options)) || Object.keys(options).length > 200) throw new Error("Check the website settings.");
  for (const [host, preferences] of Object.entries(options)) {
    if (!value.sites.includes(host) || publicHost(host) !== host || !preferences || typeof preferences !== "object" ||
        Array.isArray(preferences) || ![Object.prototype, null].includes(Object.getPrototypeOf(preferences)) ||
        Object.entries(preferences).some(([key, option]) => !preferenceKeys.includes(key) || typeof option !== "boolean")) throw new Error("Check the website settings.");
  }
  const siteOptions = Object.fromEntries(Object.keys(options).map(host => [host, sitePreferences({ siteOptions: options }, host)]));
  return { enabled: value.enabled, clientId: value.clientId, sites: [...new Set(value.sites)], siteOptions };
}
