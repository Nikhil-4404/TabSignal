import test from "node:test";
import assert from "node:assert/strict";
import { defaults, activityFor, tabHost, validateSettings, cleanTitle, siteIcon, mediaDetails, publicLink, permissionOrigin, sitePreferences, applyPresentation } from "../extension/activity.js";
import { validateMessage, discordActivity } from "../native/bridge.js";

const settings = { enabled: true, clientId: "123456789012345678", sites: ["www.youtube.com"] };
const tab = { url: "https://www.youtube.com/watch?v=secret&token=private#fragment", title: "A useful video", incognito: false };

test("sharing is opt-in, exact-host only, and limited to normal tabs", () => {
  assert.equal(activityFor(tab, defaults), null);
  assert.deepEqual(activityFor(tab, settings), { host: "www.youtube.com", title: "A useful video", iconUrl: "https://icons.bitwarden.net/www.youtube.com/icon.png", mode: "watching" });
  assert.equal(activityFor({ ...tab, incognito: true }, settings), null);
  assert.equal(activityFor({ ...tab, url: "https://evil.www.youtube.com/" }, settings), null);
  assert.equal(activityFor(tab, { ...settings, clientId: "token" }), null);
});

test("legacy settings preserve sharing and per-site preferences accept only allowed hosts and booleans", () => {
  const expected = { enabled: true, media: true, artwork: true, progress: true, links: true };
  assert.deepEqual(validateSettings(settings), { ...settings, siteOptions: {} });
  assert.deepEqual(sitePreferences(settings, "www.youtube.com"), expected);
  const configured = validateSettings({ ...settings, siteOptions: { "www.youtube.com": { enabled: false, progress: false } } });
  assert.deepEqual(sitePreferences(configured, "www.youtube.com"), { ...expected, enabled: false, progress: false });
  assert.equal(activityFor(tab, configured), null);
  assert.deepEqual(validateSettings({ ...settings, sites: [], siteOptions: {} }).siteOptions, {});
  for (const siteOptions of [null, [], "bad", new Date(), { "elsewhere.com": {} }, { "www.youtube.com": null },
    { "www.youtube.com": [] }, { "www.youtube.com": { unknown: true } }, { "www.youtube.com": { media: "false" } },
    { "www.youtube.com": Object.create({ artwork: false }) }]) {
    assert.throws(() => validateSettings({ ...settings, siteOptions }), /website settings/);
  }
  assert.throws(() => validateSettings({ ...settings, sites: [], siteOptions: { "www.youtube.com": {} } }), /website settings/);
});

test("site display controls remove images, playback and links at both outbound boundaries", () => {
  const media = { title: "Video title", service: "YouTube", subtitle: "Creator",
    artworkUrl: "https://cdn.example.com/cover.jpg", pageUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    secondaryUrl: "https://www.youtube.com/@creator", secondaryLabel: "View Channel",
    playback: { position: 30, duration: 120, paused: false, rate: 1, observedAt: Date.now() } };
  for (const key of ["artwork", "progress", "links"]) {
    const options = { [key]: false };
    const configured = { ...settings, siteOptions: { "www.youtube.com": options } };
    const activity = applyPresentation({ ...activityFor(tab, configured), media }, sitePreferences(configured, "www.youtube.com"));
    const checked = validateMessage({ type: "activity", clientId: settings.clientId, activity }).activity;
    const payload = discordActivity(checked);
    if (key === "artwork") {
      assert.equal(activity.iconUrl, undefined);
      assert.equal(activity.media.artworkUrl, undefined);
      assert.equal(checked.iconUrl, undefined);
      assert.equal(payload.assets, undefined);
      assert(payload.timestamps && payload.buttons);
      assert.equal(discordActivity({ ...checked, mode: "browsing" }).assets, undefined);
    } else if (key === "progress") {
      assert.equal(activity.media.playback, undefined);
      assert.equal(checked.media.playback, undefined);
      assert.equal(payload.timestamps, undefined);
      assert(payload.assets && payload.buttons);
    } else {
      for (const field of ["pageUrl", "secondaryUrl", "secondaryLabel"]) {
        assert.equal(activity.media[field], undefined);
        assert.equal(checked.media[field], undefined);
      }
      assert.equal(payload.buttons, undefined);
      assert(payload.assets && payload.timestamps);
    }
    // The native boundary must enforce the preference even on an unfiltered browser report.
    const unfiltered = validateMessage({ type: "activity", clientId: settings.clientId,
      activity: { ...activityFor(tab, settings), media, presentation: options } }).activity;
    const guarded = discordActivity(unfiltered);
    assert.equal(guarded[key === "artwork" ? "assets" : key === "progress" ? "timestamps" : "buttons"], undefined);
  }
  const basic = activityFor(tab, settings);
  assert.equal(basic.presentation, undefined);
  assert.equal(validateMessage({ type: "activity", clientId: settings.clientId, activity: basic }).activity.presentation, undefined);
  for (const presentation of [null, [], "bad", new Date(), { unknown: false }, { artwork: "false" }, { links: null }]) {
    assert.throws(() => validateMessage({ type: "activity", clientId: settings.clientId, activity: { ...basic, presentation } }), /presentation/);
  }
});

test("restricted pages, credentials, literal IPs and local names never produce a host", () => {
  for (const url of ["chrome://settings", "brave://settings", "file:///C:/private.txt", "about:blank", "https://127.0.0.1", "http://192.168.1.1", "https://[::1]", "http://localhost", "http://host.local", "http://device.home.arpa", "https://user:password@example.com", "broken"]) {
    assert.equal(tabHost({ url }), null, url);
  }
});

test("paths, credentials, queries and fragments do not enter the outbound payload", () => {
  const activity = activityFor(tab, settings);
  const payload = discordActivity(validateMessage({ type: "activity", clientId: settings.clientId, activity }).activity);
  assert.deepEqual(payload, { name: "YouTube", type: 3, details: "A useful video", state: "www.youtube.com",
    assets: { large_image: "https://icons.bitwarden.net/www.youtube.com/icon.png", large_text: "A useful video" } });
  assert(!JSON.stringify(payload).includes("secret"));
});

test("video paths show Watching while home/search/ordinary pages show Browsing", () => {
  const options = { ...settings, sites: ["example.com", "hianime.at"] };
  for (const path of ["/watch/episode-16", "/watch?v=private", "/shorts/abc", "/embed/abc", "/anime/episode/16", "/videos/123"]) {
    const activity = activityFor({ url: `https://example.com${path}`, title: "Video" }, options);
    const payload = discordActivity(validateMessage({ type: "activity", clientId: options.clientId, activity }).activity);
    assert.equal(activity.mode, "watching", path);
    assert.equal(payload.name, "example.com");
    assert.equal(payload.type, 3);
    assert.equal(payload.state, "example.com");
  }
  for (const path of ["/", "/home", "/search?q=watch", "/watchlist", "/article/about-video", "/?next=/watch/16"]) {
    const activity = activityFor({ url: `https://hianime.at${path}`, title: "HiAnime homepage" }, options);
    const payload = discordActivity(activity);
    assert.equal(activity.mode, "browsing", path);
    assert.equal(payload.name, "Browsing");
    assert.equal(payload.type, 0);
    assert.equal(payload.state, "hianime.at");
  }
});

test("rich media uses artwork, channel, verified links and the actual player timeline", () => {
  const now = Date.now();
  const media = { title: "The current episode", service: "YouTube", subtitle: "The creator",
    artworkUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg?token=private",
    pageUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&token=private#secret",
    secondaryUrl: "https://www.youtube.com/@creator?tracking=private", secondaryLabel: "Untrusted label",
    playback: { position: 30, duration: 120, paused: false, rate: 1, observedAt: now } };
  const checked = validateMessage({ type: "activity", clientId: settings.clientId, activity: { ...activityFor(tab, settings), media } }).activity;
  const payload = discordActivity(checked);
  assert.equal(payload.name, "YouTube");
  assert.equal(payload.details, "The current episode");
  assert.equal(payload.state, "The creator");
  assert.equal(payload.assets.large_image, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  assert.equal(payload.assets.small_image, "https://icons.bitwarden.net/www.youtube.com/icon.png");
  assert.equal(payload.timestamps.end - payload.timestamps.start, 120);
  assert(Math.abs(payload.timestamps.start - (now / 1000 - 30)) < 1);
  assert.deepEqual(payload.buttons, [{ label: "Watch Video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    { label: "View Channel", url: "https://www.youtube.com/@creator" }]);
  assert(!JSON.stringify(payload).includes("private"));
  assert(!("color" in payload));
  for (const change of [{ paused: true }, { rate: 2 }, { observedAt: now - 91000 }, { duration: Infinity }, { position: -1 }]) {
    const value = discordActivity({ ...checked, media: { ...media, playback: { ...media.playback, ...change } } });
    assert.equal(value.timestamps, undefined, JSON.stringify(change));
  }
  assert.equal(discordActivity({ ...checked, mode: "browsing" }).buttons, undefined);
});

test("media trust boundaries reject private images/links and bound exact permission origins", () => {
  const value = mediaDetails({ title: "x".repeat(600), service: "x".repeat(600), subtitle: "x".repeat(600),
    artworkUrl: "http://localhost/private.png", pageUrl: "https://elsewhere.com/private", secondaryUrl: "javascript:alert(1)",
    playback: { position: 1, duration: 10, paused: "no", rate: 1, observedAt: Date.now() }, embedOrigins: ["private"], embedFrames: ["private"] }, "hianime.at");
  assert.equal(value.title.length, 128);
  assert.equal(value.service.length, 32);
  assert.equal(value.subtitle.length, 128);
  assert.equal(value.artworkUrl, undefined);
  assert.equal(value.pageUrl, undefined);
  assert.equal(value.secondaryUrl, undefined);
  assert.equal(value.playback, undefined);
  assert.equal(value.embedOrigins, undefined);
  assert.equal(value.embedFrames, undefined);
  assert.equal(mediaDetails({ playback: { duration: 0.01, position: 0.005, rate: 1, paused: false, observedAt: Date.now() } }, "example.com").playback.duration, 0.01);
  assert.equal(publicLink("https://hianime.at/watch/baki-1424?ep=24986&token=private", "hianime.at"), "https://hianime.at/watch/baki-1424?ep=24986");
  assert.equal(publicLink("https://example.com/path?token=private#secret", "example.com"), "https://example.com/path");
  assert.equal(permissionOrigin("https://example.com/watch?private=1"), "https://example.com/*");
  for (const url of ["https://localhost/", "https://127.0.0.1/", "https://user:password@example.com/", "https://example.com:8443/", "file:///private"]) assert.equal(permissionOrigin(url), null);
});

test("native boundary rejects unknown modes and accepts old messages as browsing", () => {
  const activity = { host: "example.com", title: "A page" };
  assert.equal(validateMessage({ type: "activity", clientId: settings.clientId, activity }).activity.mode, "browsing");
  for (const mode of [null, "playing", "Watching", 3]) {
    assert.throws(() => validateMessage({ type: "activity", clientId: settings.clientId, activity: { ...activity, mode } }));
  }
});

test("allowed websites use canonical PNG icons without forwarding page or favicon data", () => {
  for (const host of ["github.com", "www.wikipedia.org", "hianime.at", "www.youtube.com"]) {
    const options = { ...settings, sites: [host] };
    const icon = `https://icons.bitwarden.net/${host}/icon.png`;
    const activity = activityFor({ url: `https://${host}/private/path?token=secret#fragment`, title: "A public page",
      favIconUrl: "https://unrelated.com/private.svg?token=secret#fragment" }, options);
    assert.equal(activity.iconUrl, icon);
    const checked = validateMessage({ type: "activity", clientId: options.clientId, activity });
    assert.equal(checked.activity.iconUrl, icon);
    assert.equal(discordActivity(checked.activity).assets.large_image, icon);
    assert(!JSON.stringify(checked).includes("secret"));
    assert.equal(activityFor({ url: `https://${host}/` }, { ...options, enabled: false }), null);
    assert.equal(activityFor({ url: `https://${host}/` }, { ...options, sites: [] }), null);
    assert.equal(activityFor({ url: `https://${host}/`, incognito: true }, options), null);
  }
});

test("icon lookups reject non-public hosts and native messages ignore legacy untrusted icon URLs", () => {
  for (const host of [undefined, null, "localhost", "127.0.0.1", "device.local", "device.home.arpa", "https://example.com", "example.com/path", "example.com?token=secret"]) {
    assert.equal(siteIcon(host), null);
  }
  const longestHost = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
  assert.equal(longestHost.length, 253);
  assert(siteIcon(longestHost).length <= 300);
  assert.equal(siteIcon(longestHost + "d"), null);
  for (const iconUrl of [undefined, "https://unrelated.com/private.png?token=secret", "https://localhost/private", "data:image/png;base64,private"]) {
    const checked = validateMessage({ type: "activity", clientId: settings.clientId,
      activity: { host: "example.com", title: "Public title", iconUrl } });
    assert.equal(checked.activity.iconUrl, "https://icons.bitwarden.net/example.com/icon.png");
    assert.equal(discordActivity(checked.activity).assets.large_image, checked.activity.iconUrl);
    assert(!JSON.stringify(checked).includes("private"));
  }
});

test("titles are plain bounded text and invalid settings/messages are rejected", () => {
  assert.equal(cleanTitle(" \n Hello\u202e world\t ", "example.com"), "Hello world");
  assert.equal(cleanTitle("", "example.com"), "example.com");
  assert.equal(Array.from(cleanTitle("😀".repeat(200), "example.com")).length, 128);
  assert.deepEqual(validateSettings({ ...settings, sites: ["www.youtube.com", "www.youtube.com"] }).sites, ["www.youtube.com"]);
  for (const value of [{ ...settings, sites: [null] }, { ...settings, sites: ["*.example.com"] }, { ...settings, clientId: "secret" }]) assert.throws(() => validateSettings(value));
  for (const activity of [{ host: null, title: "x" }, { host: "127.0.0.1", title: "x" }, { host: "example.com", title: "x".repeat(513) }]) {
    assert.throws(() => validateMessage({ type: "activity", clientId: settings.clientId, activity }));
  }
});
