import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readMedia } from "../extension/media.js";

const node = (textContent = "", attributes = {}) => ({ textContent, getAttribute: name => attributes[name] ?? null });
const frame = (src, overrides = {}) => ({ ...node("", { src }), closest: () => null,
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 640, bottom: 360 }), ...overrides });
const video = (overrides = {}) => ({
  duration: 120, currentTime: 30, paused: false, playbackRate: 1, poster: "",
  closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, right: 640, bottom: 360 }),
  ...overrides
});

function inspect({ url = "https://example.com/watch/episode", expectedUrl = url, title = "An episode", singles = {}, lists = {}, videos = [], frames = [], anchors = [], metadata } = {}) {
  const document = {
    title,
    querySelector: selector => singles[selector] || null,
    querySelectorAll: selector => lists[selector] || (selector === "video" ? videos : selector === "iframe[src]" ? frames : anchors)
  };
  const context = vm.createContext({
    document, location: { href: url }, navigator: { mediaSession: { metadata } }, URL,
    innerWidth: 1280, innerHeight: 720,
    getComputedStyle: element => ({ display: "block", visibility: "visible", opacity: "1", ...element.style }),
    Date: { now: () => 1700000000000 }
  });
  // executeScript serializes the function without its module scope.
  return JSON.parse(JSON.stringify(vm.runInContext(`(${readMedia.toString()})(${JSON.stringify(expectedUrl)})`, context)));
}

test("serialized reader rejects another document URL before reading its DOM", () => {
  const context = vm.createContext({ location: { href: "https://unlisted.example.com/private" },
    document: new Proxy({}, { get() { assert.fail("Unapproved document was read"); } }) });
  assert.equal(vm.runInContext(`(${readMedia.toString()})("https://example.com/watch/episode")`, context), null);
  assert.equal(vm.runInContext(`(${readMedia.toString()})()`, context), null);
  assert.equal(inspect({ expectedUrl: "https://example.com/watch/other-episode" }), null);
  assert.equal(inspect({ expectedUrl: "https://example.com/watch/episode#changed" }), null);
});

test("serialized media reader uses real playback and public metadata without module helpers", () => {
  const result = inspect({
    singles: { 'meta[property="og:title"]': node("", { content: "Baki Episode 16" }), 'meta[property="og:image"]': node("", { content: "/cover.png" }) },
    metadata: { artist: "Public artist", artwork: [{ src: "https://cdn.example.com/cover.jpg" }] },
    videos: [video({ paused: true, playbackRate: 1.5 })]
  });
  assert.equal(result.title, "Baki Episode 16");
  assert.equal(result.subtitle, "Public artist");
  assert.equal(result.artworkUrl, "https://cdn.example.com/cover.jpg");
  assert.deepEqual(result.playback, { position: 30, duration: 120, paused: true, rate: 1.5, observedAt: 1700000000000 });
});

test("largest visible non-ad finite video wins; metadata alone never fabricates playback", () => {
  const result = inspect({ videos: [
    video({ duration: Infinity }), video({ closest: () => ({}) }),
    video({ style: { display: "none" } }), video({ style: { opacity: "0" } }),
    video({ getBoundingClientRect: () => ({ left: 2000, top: 0, right: 2500, bottom: 500 }) }),
    video({ currentTime: 10, getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100 }) }),
    video({ currentTime: 42, poster: "/episode.jpg" })
  ] });
  assert.equal(result.playback.position, 42);
  assert.equal(result.artworkUrl, "https://example.com/episode.jpg");
  const metadataOnly = inspect({ metadata: { title: "A movie", artwork: [] } });
  assert.equal(metadataOnly.playback, undefined);
  assert.equal(metadataOnly.title, "A movie");
  for (const bad of [video({ duration: 0 }), video({ currentTime: NaN }), video({ playbackRate: 0 })]) assert.equal(inspect({ videos: [bad] }).playback, undefined);
});

test("YouTube uses the current title, verified channel anchor and public thumbnail fallback", () => {
  const result = inspect({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&private=local",
    singles: { 'ytd-watch-metadata h1 yt-formatted-string, h1.ytd-watch-metadata, h1 yt-formatted-string': node(" Current video ") },
    anchors: [node("External", { href: "https://evil.example.com/@channel" }), node("The creator", { href: "/@creator" })]
  });
  assert.equal(result.title, "Current video");
  assert.equal(result.service, "YouTube");
  assert.equal(result.subtitle, "The creator");
  assert.equal(result.secondaryUrl, "https://www.youtube.com/@creator");
  assert.equal(result.secondaryLabel, "View channel");
  assert.equal(result.artworkUrl, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  assert.equal(result.playback, undefined);
  assert.equal(inspect({ url: "https://www.youtube.com/", anchors: [] }).artworkUrl, undefined);
});

test("series buttons require a same-site anchor in the scoped breadcrumb/title selectors", () => {
  const result = inspect({ url: "https://hianime.at/watch/baki-1424?ep=24986", anchors: [
    node("Home", { href: "/home" }), node("Elsewhere", { href: "https://other.example.com/anime/baki" }),
    node("Genre", { href: "/genre/action" }), node("Baki", { href: "/baki-1424" })
  ] });
  assert.equal(result.secondaryUrl, "https://hianime.at/baki-1424");
  assert.equal(result.secondaryLabel, "View series");
  assert.equal(result.service, "HiAnime");
  assert.equal(result.subtitle, "Baki");
  assert.equal(inspect({ anchors: [node("Unrelated", { href: "/search?q=episode" })] }).secondaryUrl, undefined);
});

test("HiAnime episode changes override stale page, Open Graph and media-session titles without a reload", () => {
  const singles = {
    'meta[property="og:title"]': node("", { content: "Baki Episode 16 | HiAnime" }),
    ".anisc-detail .film-name a[href]": node("Baki", { href: "/watch/baki-1424" })
  };
  const metadata = { title: "Baki Episode 16 | HiAnime" };
  for (const [id, number] of [["24986", "16"], ["24987", "17"], ["24986", "16"]]) {
    const url = `https://hianime.at/watch/baki-1424?ep=${id}`;
    const result = inspect({ url, title: "Baki Episode 16 | HiAnime", singles, metadata,
      lists: { "#detail-ss-list a.ep-item.active": [node(`${number} Episode title`, { href: url, "data-id": id, "data-number": number })] },
      videos: [video({ currentTime: 12 })] });
    assert.equal(result.title, `Baki Episode ${number}`);
    assert.equal(result.pageUrl, url);
    assert.equal(result.playback.position, 12, "Correcting the title must preserve player timing");
  }
});

test("HiAnime transitional, ambiguous or mismatched episode rows never reuse the old episode or guess from its ID", () => {
  const url = "https://hianime.at/watch/baki-1424?ep=24987";
  const attributes = { href: url, "data-id": "24987", "data-number": "17" };
  const episode = overrides => node("17 Dad!", { ...attributes, ...overrides });
  const options = { url, title: "Baki Episode 16 | HiAnime", metadata: { title: "Baki Episode 16" },
    singles: { ".anisc-detail .film-name a[href]": node("Baki", { href: "/watch/baki-1424" }),
      'meta[property="og:title"]': node("", { content: "Baki Episode 16" }) } };
  for (const rows of [[], [episode(), episode()],
    [episode({ href: "/watch/baki-1424?ep=24986", "data-id": "24986", "data-number": "16" })],
    [episode({ href: "https://elsewhere.com/watch/baki-1424?ep=24987" })],
    [episode({ href: "/watch/other-anime?ep=24987" })],
    [episode({ "data-id": "24986" })], [episode({ "data-number": "" })], [episode({ "data-number": "17 fake" })]]) {
    assert.equal(inspect({ ...options, lists: { "#detail-ss-list a.ep-item.active": rows } }).title, "Baki");
  }
  assert.equal(inspect({ ...options, url: "https://hianime.at/watch/baki-1424",
    lists: { "#detail-ss-list a.ep-item.active": [episode()] } }).title, "Baki");
  assert.equal(inspect({ ...options, lists: { "#detail-ss-list a.ep-item.active": [episode({ "data-number": "12.5" })] } }).title, "Baki Episode 12.5");
});

test("iframe permission requests use bounded public origins; exact frame sources stay local", () => {
  const result = inspect({ frames: [
    "https://player.example.com/embed/123?token=private", "https://player.example.com/another",
    "http://unsecured.example.com/embed", "https://127.0.0.1/embed", "https://player.local/embed",
    "https://user:password@example.com/embed", "https://player.example.com:8443/embed", "javascript:alert(1)",
    "https://stream.example.net/video#private"
  ].map(src => frame(src)) });
  assert.deepEqual(result.embedOrigins, ["https://player.example.com", "https://stream.example.net"]);
  assert.equal(result.embedFrames[0], "https://player.example.com/embed/123?token=private");
  assert.equal(inspect({ frames: Array.from({ length: 30 }, (_, index) => frame(`https://player${index}.example.com/embed`)) }).embedOrigins.length, 16);
  assert.equal(inspect({ title: "x".repeat(2000) }).title.length, 512);
});

test("only plausible non-ad player frames offer additional origin permission", () => {
  const small = () => ({ left: 0, top: 0, right: 1, bottom: 1 });
  const result = inspect({ frames: [
    frame("https://metrics.example.com/pixel", { getBoundingClientRect: small }),
    frame("https://ads.example.com/ads/embed"),
    frame("https://player.example.com/embed", { style: { display: "none" } }),
    frame("https://video.example.com/stream", { getBoundingClientRect: small, getAttribute: key => ({ src: "https://video.example.com/stream", title: "Video player" })[key] }),
    frame("https://stream.example.com/frame")
  ] });
  assert.deepEqual(result.embedOrigins, ["https://video.example.com", "https://stream.example.com"]);
});

test("service names and subtitles come from known hosts or scoped public metadata", () => {
  const result = inspect({ title: "Episode 16 | HiAnime", url: "https://hianime.at/watch/baki-1424" });
  assert.equal(result.title, "Episode 16");
  assert.equal(result.service, "HiAnime");
  const description = "A public episode description. ".repeat(10);
  const metadata = { singles: { 'meta[property="og:site_name"]': node("", { content: "Example TV" }),
    'meta[property="og:description"]': node("", { content: description }) } };
  assert.equal(inspect(metadata).subtitle, undefined);
  metadata.singles['meta[property="og:type"]'] = node("", { content: "video.episode" });
  assert.equal(inspect(metadata).subtitle.length, 128);
  assert.equal(inspect(metadata).service, "Example TV");
});
