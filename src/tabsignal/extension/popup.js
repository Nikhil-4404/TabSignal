import { serviceName, sitePreferences } from "./activity.js";
import { companionDownload, onboardingFor } from "./onboarding.js";

const $ = id => document.getElementById(id);
let view;
let selectedHost = null;
let busy = false;
let requestRevision = 0;
let listKey = "";

function websiteInfo(host) {
  const domain = host.replace(/^www\./, "");
  const known = {
    "hianime.at": ["HiAnime", "hianime", "Video"],
    "youtube.com": ["YouTube", "youtube", "Video"],
    "m.youtube.com": ["YouTube", "youtube", "Video"],
    "netflix.com": ["Netflix", "netflix", "Video"],
    "disneyplus.com": ["Disney+", "disney", "Video"],
    "twitch.tv": ["Twitch", "twitch", "Live"],
    "soundcloud.com": ["SoundCloud", "soundcloud", "Music"]
  }[domain];
  return known ? { name: known[0], brand: known[1], category: known[2], logo: `assets/${known[1]}.svg` }
    : { name: serviceName(host), brand: "generic", category: "Website", logo: null };
}

function clock(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60);
  return `${hours ? `${hours}:${String(minutes % 60).padStart(2, "0")}` : minutes}:${String(whole % 60).padStart(2, "0")}`;
}

function showWebsite(host) {
  selectedHost = host;
  render(view);
  $(host ? "back" : "search").focus();
  $("scrollArea").scrollTop = 0;
}

function renderSites() {
  const query = $("search").value.trim().toLowerCase();
  const hosts = view.settings.sites.filter(host => `${host} ${websiteInfo(host).name}`.toLowerCase().includes(query));
  const key = JSON.stringify([hosts, hosts.map(host => sitePreferences(view.settings, host).enabled), view.activity?.host]);
  $("siteCount").textContent = `${view.settings.sites.length} ${view.settings.sites.length === 1 ? "website" : "websites"}`;
  $("empty").hidden = view.settings.sites.length > 0;
  $("noResults").hidden = !view.settings.sites.length || hosts.length > 0;
  if (listKey === key) return;
  listKey = key;
  $("sites").replaceChildren(...hosts.map(host => {
    const info = websiteInfo(host);
    const enabled = sitePreferences(view.settings, host).enabled;
    const li = document.createElement("li");
    li.className = "website-item"; li.dataset.brand = info.brand;
    li.dataset.active = String(view.activity?.host === host);
    const card = document.createElement("button");
    card.type = "button"; card.className = "website-card";
    card.setAttribute("aria-label", `Open ${info.name} settings, ${host}${enabled ? "" : ", sharing paused"}`);
    const logo = document.createElement(info.logo ? "img" : "span");
    logo.className = info.logo ? "site-card-logo" : "site-card-initial";
    if (info.logo) { logo.src = info.logo; logo.alt = ""; }
    else logo.textContent = info.name.slice(0, 1).toUpperCase();
    const copy = document.createElement("span");
    copy.className = "site-card-copy";
    const name = document.createElement("strong");
    name.className = "site-card-name"; name.textContent = info.name;
    const domain = document.createElement("span");
    domain.className = "site-card-domain"; domain.textContent = host;
    copy.append(name, domain);
    const category = document.createElement("span");
    category.className = "site-card-category"; category.textContent = enabled ? info.category : "Paused";
    card.append(logo, copy, category);
    card.addEventListener("click", () => showWebsite(host));
    const gear = document.createElement("button");
    gear.type = "button"; gear.className = "site-card-settings";
    gear.setAttribute("aria-label", `Settings for ${host}`);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#icon-settings"); svg.append(use); gear.append(svg);
    gear.addEventListener("click", () => showWebsite(host));
    li.append(card, gear);
    return li;
  }));
}

function renderPreview(activity, options, next) {
  const media = activity?.media;
  $("title").textContent = media?.title || activity?.title || "Nothing shared";
  $("mode").textContent = activity ? activity.mode === "watching" ? `Watching ${media?.service || serviceName(activity.host)}` : "Browsing" : "Private";
  $("subtitle").textContent = media?.subtitle || "";
  $("subtitle").hidden = !media?.subtitle;
  $("site").textContent = activity?.host || selectedHost;
  $("previewNotice").hidden = Boolean(activity);
  $("previewNotice").textContent = !view.settings.enabled ? "Sharing is off." : !options.enabled ? "Sharing is paused for this website." :
    view.host === selectedHost ? next.reason : "Open this website in the active browser tab to preview its activity.";
  const artwork = options.artwork ? media?.artworkUrl || activity?.iconUrl : null;
  if ($("artwork").getAttribute("src") !== artwork) {
    if (artwork) $("artwork").src = artwork;
    else $("artwork").removeAttribute("src");
    $("artwork").hidden = !artwork;
  }
  const p = options.progress ? media?.playback : null;
  $("progress").hidden = !p;
  if (p) {
    const position = Math.min(p.duration, p.position + (p.paused ? 0 : Math.max(0, Date.now() - p.observedAt) / 1000 * p.rate));
    $("playbackProgress").value = position / p.duration;
    $("playbackTime").textContent = `${clock(position)} / ${clock(p.duration)}`;
  }
  $("mediaStatus").hidden = !activity || activity.mode !== "watching";
  $("mediaStatus").textContent = !options.media ? "Basic title and website only" : !options.progress ? "Playback progress is hidden" : p ?
    p.paused ? "Paused · Discord timer hidden" : p.rate === 1 ? "Playing · timing available" : `Playing at ${p.rate}× · Discord timer hidden` :
    !next.mediaAccess ? "Enable media access for artwork and progress" : next.mediaRequest ?
      `Allow player access on ${new URL(next.mediaRequest).hostname}` : "No supported player detected · start the video and check again";
  const links = options.links && media?.pageUrl ? [{ label: /youtube\.com$/.test(activity.host) ? "Watch Video" : activity.host === "hianime.at" ? "Watch Episode" : "Watch Now", url: media.pageUrl },
    ...(media.secondaryUrl ? [{ label: media.secondaryLabel, url: media.secondaryUrl }] : [])] : [];
  $("links").hidden = !links.length;
  if ($("links").dataset.links !== JSON.stringify(links)) {
    $("links").dataset.links = JSON.stringify(links);
    $("links").replaceChildren(...links.map(link => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.textContent = link.label; a.href = link.url; a.target = "_blank"; a.rel = "noreferrer";
      li.append(a); return li;
    }));
  }
}

function render(next) {
  view = next;
  if (selectedHost && !next.settings.sites.includes(selectedHost)) selectedHost = null;
  $("enabled").checked = next.settings.enabled;
  $("enabled").disabled = busy || (!next.settings.enabled && (!next.helperReady || !next.settings.sites.length));
  $("back").hidden = !selectedHost;
  $("pageTitle").textContent = selectedHost ? "Website settings" : "TabSignal";
  $("websitesView").hidden = Boolean(selectedHost);
  $("websiteView").hidden = !selectedHost;
  $("reason").textContent = next.reason;
  $("connection").textContent = next.connection;
  $("connection").dataset.state = next.connectionState === "shared" ? "connected" :
    ["unavailable", "incompatible", "discord-unavailable", "error"].includes(next.connectionState) ? "error" : "pending";
  $("companionVersion").textContent = next.helperReady ? `Windows companion · v${next.helperVersion}` : "Windows companion";
  const onboarding = onboardingFor(next);
  $("onboarding").hidden = !onboarding.visible;
  $("onboardingTitle").textContent = onboarding.title;
  $("onboardingHelp").textContent = onboarding.description;
  const download = companionDownload();
  $("downloadCompanion").hidden = !onboarding.showDownload || !download;
  if (download) $("downloadCompanion").href = download;
  $("downloadCompanion").textContent = onboarding.downloadLabel;
  $("downloadUnavailable").hidden = !onboarding.showDownload || Boolean(download);
  $("checkConnection").hidden = !onboarding.showCheck;
  $("checkConnection").disabled = busy || onboarding.checkDisabled;
  $("allow").disabled = busy || !next.host || next.settings.sites.includes(next.host) || next.settings.sites.length >= 200;
  $("allow").textContent = next.host ? next.settings.sites.includes(next.host) ? "Current website already added" : `+ Add ${next.host}` : "Open a website to add it";
  renderSites();
  if (!selectedHost) return;
  const info = websiteInfo(selectedHost);
  const options = sitePreferences(next.settings, selectedHost);
  $("siteHero").dataset.brand = info.brand;
  $("siteName").textContent = info.name;
  $("siteDomain").textContent = selectedHost;
  $("siteState").textContent = options.enabled ? "Allowed" : "Paused";
  $("siteState").dataset.paused = String(!options.enabled);
  $("siteLogo").hidden = !info.logo;
  if (info.logo) $("siteLogo").src = info.logo;
  $("siteInitial").hidden = Boolean(info.logo);
  $("siteInitial").textContent = info.name.slice(0, 1).toUpperCase();
  $("sitePause").querySelector("span").textContent = options.enabled ? "Pause sharing" : "Resume sharing";
  $("sitePause").disabled = busy;
  $("siteRemove").disabled = busy;
  for (const [key, id] of Object.entries({ enabled: "siteEnabled", media: "siteMedia", artwork: "siteArtwork", progress: "siteProgress", links: "siteLinks" })) {
    $(id).checked = options[key]; $(id).disabled = busy;
  }
  $("siteMediaHelp").textContent = !options.media ? "Use basic title and website only" : "Read title and series information with site access";
  const activity = next.activity?.host === selectedHost ? next.activity : null;
  $("playerAccess").hidden = !activity || !options.media || !next.mediaRequest;
  $("playerAccess").disabled = busy;
  $("playerAccess").textContent = next.mediaRequest ? `${next.mediaAccess ? "Read player on" : "Enable media access for"} ${new URL(next.mediaRequest).hostname}` : "Enable media access";
  renderPreview(activity, options, next);
}

async function request(message, initial = false) {
  const current = ++requestRevision;
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (current !== requestRevision) return false;
    if (!result || result.error) throw new Error(result?.error || "Extension did not respond. Reload it and try again.");
    render(result);
    if (message.type !== "view" || initial) $("error").textContent = "";
    return true;
  } catch (error) {
    if (current !== requestRevision) return false;
    $("error").textContent = error.message;
    if (view) render(view);
    return false;
  }
}

async function save(change) {
  if (!view || busy) { if (view) render(view); return false; }
  busy = true;
  render(view);
  try { return await request({ type: "save", settings: { ...view.settings, ...change } }); }
  finally { busy = false; render(view); }
}

async function saveSite(change) {
  if (!selectedHost || !view) return;
  const siteOptions = { ...view.settings.siteOptions, [selectedHost]: { ...sitePreferences(view.settings, selectedHost), ...change } };
  await save({ siteOptions });
}

$("back").addEventListener("click", () => showWebsite(null));
$("search").addEventListener("input", () => { if (view) renderSites(); });
$("openSetup").addEventListener("click", () => {
  $("setup").open = !$("setup").open;
  if ($("setup").open) { $("setup").scrollIntoView({ block: "start" }); $("retry").focus(); }
});
$("enabled").addEventListener("change", () => save({ enabled: $("enabled").checked }));
$("allow").addEventListener("click", async () => {
  const host = view?.host;
  if (host && await save({ sites: [...view.settings.sites, host] })) showWebsite(host);
});
$("sitePause").addEventListener("click", () => saveSite({ enabled: !sitePreferences(view.settings, selectedHost).enabled }));
$("siteRemove").addEventListener("click", async () => {
  const host = selectedHost;
  const siteOptions = { ...view.settings.siteOptions }; delete siteOptions[host];
  if (await save({ sites: view.settings.sites.filter(site => site !== host), siteOptions })) {
    showWebsite(null);
    try { await chrome.permissions.remove({ origins: [`https://${host}/*`, `http://${host}/*`] }); }
    catch { $("error").textContent = "Sharing stopped. Site access could not be removed; manage it in the browser's extension settings."; }
  }
});
for (const [id, key] of Object.entries({ siteEnabled: "enabled", siteMedia: "media", siteArtwork: "artwork", siteProgress: "progress", siteLinks: "links" })) {
  $(id).addEventListener("change", () => saveSite({ [key]: $(id).checked }));
}
$("retry").addEventListener("click", () => { if (!busy) request({ type: "retry" }); });
$("checkConnection").addEventListener("click", () => { if (!busy) request({ type: "retry" }); });
$("artwork").referrerPolicy = "no-referrer";
$("artwork").addEventListener("error", () => { $("artwork").hidden = true; });
$("playerAccess").addEventListener("click", async () => {
  if (!view?.mediaRequest || busy || view.activity?.host !== selectedHost) return;
  busy = true;
  const origin = view.mediaRequest;
  render(view);
  try {
    const granted = await chrome.permissions.request({ permissions: ["scripting", "webNavigation"], origins: [origin] });
    if (!granted) throw new Error("Media access was not granted. Basic activity sharing still works.");
    await request({ type: "retry" });
  } catch (error) { $("error").textContent = error.message; }
  finally { busy = false; render(view); }
});
$("version").textContent = `v${chrome.runtime.getManifest().version}`;
await request({ type: "view" }, true);
setInterval(() => { if (!busy) request({ type: "view" }); }, 2000);
