export function readMedia(expectedUrl) {
  if (typeof expectedUrl !== "string" || location.href !== expectedUrl) return null;
  const text = value => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 512) : "";
  const absoluteUrl = value => {
    if (typeof value !== "string" || !value || value.length > 2048) return undefined;
    try {
      const url = new URL(value, location.href);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2048 ? url.href : undefined;
    } catch { return undefined; }
  };
  const meta = selector => text(document.querySelector(selector)?.getAttribute("content"));
  const page = new URL(location.href);
  const youtube = /(^|\.)youtube\.com$/.test(page.hostname);
  const metadata = navigator.mediaSession?.metadata;
  const service = (youtube ? "YouTube" : /(^|\.)hianime\.[a-z]{2,}$/.test(page.hostname) ? "HiAnime" :
    /(^|\.)netflix\.com$/.test(page.hostname) ? "Netflix" : /(^|\.)disneyplus\.com$/.test(page.hostname) ? "Disney+" :
      meta('meta[property="og:site_name"]') || page.hostname).slice(0, 128);
  let title = (youtube && text(document.querySelector("ytd-watch-metadata h1 yt-formatted-string, h1.ytd-watch-metadata, h1 yt-formatted-string")?.textContent)) ||
    text(metadata?.title) || meta('meta[property="og:title"]') || text(document.title);
  for (const separator of [" | ", " - ", " – ", " — "]) {
    const suffix = separator + service;
    if (title.toLowerCase().endsWith(suffix.toLowerCase()) && title.length > suffix.length) title = title.slice(0, -suffix.length).trim();
  }

  if (/(^|\.)hianime\.[a-z]{2,}$/.test(page.hostname) && page.pathname.startsWith("/watch/")) {
    const series = document.querySelector(".anisc-detail .film-name a[href]");
    const seriesUrl = absoluteUrl(series?.getAttribute("href"));
    if (seriesUrl) {
      const url = new URL(seriesUrl);
      const name = text(series.textContent);
      if (name && url.origin === page.origin &&
          [page.pathname, page.pathname.replace(/^\/watch/, "")].includes(url.pathname)) {
        // HiAnime leaves page metadata stale between episodes; trust only the current episode row.
        title = name;
        const rows = [...document.querySelectorAll("#detail-ss-list a.ep-item.active")].slice(0, 2);
        const episode = rows.length === 1 ? rows[0] : null;
        const episodeUrl = absoluteUrl(episode?.getAttribute("href"));
        const id = page.searchParams.get("ep");
        const number = episode?.getAttribute("data-number") || "";
        if (episodeUrl && /^\d{1,12}$/.test(id || "") && /^\d{1,5}(?:\.\d{1,2})?$/.test(number)) {
          const active = new URL(episodeUrl);
          if (active.origin === page.origin && active.pathname === page.pathname &&
              active.searchParams.get("ep") === id && episode.getAttribute("data-id") === id) {
            title = `${name} Episode ${number}`.slice(0, 512);
          }
        }
      }
    }
  }

  let channel;
  if (youtube) {
    channel = [...document.querySelectorAll('ytd-video-owner-renderer a[href], #owner #channel-name a[href]')].slice(0, 16).find(anchor => {
      const value = absoluteUrl(anchor.getAttribute("href"));
      if (!value) return false;
      const url = new URL(value);
      return /(^|\.)youtube\.com$/.test(url.hostname) && /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/?$/.test(url.pathname) && text(anchor.textContent);
    });
  }

  let secondaryUrl = channel && absoluteUrl(channel.getAttribute("href"));
  let secondaryLabel = secondaryUrl ? "View channel" : undefined;
  let seriesTitle;
  if (!youtube) {
    const candidates = [...document.querySelectorAll('main .breadcrumb a[href], #main-content .breadcrumb a[href], main [aria-label="breadcrumb"] a[href], main [aria-label="Breadcrumb"] a[href], .anisc-detail .film-name a[href]')].slice(0, 16);
    const series = candidates.reverse().find(anchor => {
      const value = absoluteUrl(anchor.getAttribute("href"));
      if (!value || !text(anchor.textContent)) return false;
      const url = new URL(value);
      return url.origin === page.origin && url.pathname !== page.pathname &&
        (/^\/(?:anime|title|series|show)\/[^/]+\/?$/.test(url.pathname) || /^\/[a-z0-9][a-z0-9-]*-\d+\/?$/i.test(url.pathname));
    });
    if (series) {
      secondaryUrl = absoluteUrl(series.getAttribute("href"));
      secondaryLabel = "View series";
      seriesTitle = text(series.textContent);
    }
  }

  let selected;
  let largestArea = 0;
  for (const video of [...document.querySelectorAll("video")].slice(0, 16)) {
    try {
      if (video.closest('.ad-showing, .ad-interrupting, [data-ad], [data-ad-slot], .video-ad, .ads, #ad-player, [aria-label*="advertisement" i]')) continue;
      const style = getComputedStyle(video);
      const rect = video.getBoundingClientRect();
      const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
      const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      const area = width * height;
      if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || Number(style.opacity) === 0 || area <= largestArea ||
          !Number.isFinite(video.duration) || video.duration <= 0 || !Number.isFinite(video.currentTime) || video.currentTime < 0 ||
          !Number.isFinite(video.playbackRate) || video.playbackRate <= 0 || typeof video.paused !== "boolean") continue;
      selected = video;
      largestArea = area;
    } catch { /* A removed player must not prevent the remaining metadata from being read. */ }
  }

  const artwork = Array.isArray(metadata?.artwork) ? metadata.artwork.slice(0, 16).map(item => absoluteUrl(item?.src)).find(Boolean) : undefined;
  let artworkUrl = artwork || absoluteUrl(selected?.poster) || absoluteUrl(meta('meta[property="og:image"]')) || absoluteUrl(meta('meta[name="twitter:image"]'));
  if (!artworkUrl && youtube) {
    const videoId = page.pathname === "/watch" ? page.searchParams.get("v") : /^\/(?:shorts|embed)\/([^/]+)/.exec(page.pathname)?.[1];
    if (/^[a-zA-Z0-9_-]{11}$/.test(videoId || "")) artworkUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }

  const embedOrigins = [];
  const embedFrames = [];
  for (const frame of [...document.querySelectorAll("iframe[src]")].slice(0, 16)) {
    const value = absoluteUrl(frame.getAttribute("src"));
    if (!value) continue;
    const url = new URL(value);
    const marker = [frame.getAttribute("id"), frame.getAttribute("name"), frame.getAttribute("title"), url.pathname].map(value => text(value)).join(" ");
    if (/(?:^|[\s_\/-])(?:ad|ads|advert|advertisement|advertising|tracking|tracker)(?:$|[\s_\/-])/i.test(marker) ||
        frame.closest('.ad-showing, [data-ad], [data-ad-slot], .video-ad, .ads')) continue;
    const rect = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || Number(style.opacity) === 0 ||
        (!/video|player|embed/i.test(marker) && !(rect.right - rect.left >= 300 && rect.bottom - rect.top >= 150))) continue;
    // shortcut: literal/local names are excluded without resolving DNS, keep final URL validation in the extension.
    const publicHost = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname) &&
      !/\.(?:localhost|local|localdomain|internal|lan|home|test|invalid|example)$/i.test(url.hostname) && !url.hostname.endsWith(".home.arpa");
    if (url.protocol === "https:" && !url.port && publicHost) {
      if (!embedOrigins.includes(url.origin)) embedOrigins.push(url.origin);
      embedFrames.push(url.href);
    }
  }

  return {
    title,
    service,
    subtitle: (text(channel?.textContent) || seriesTitle || text(metadata?.artist) ||
      (/^video(?:[.:]|$)/i.test(meta('meta[property="og:type"]')) ? meta('meta[property="og:description"]') : "") ||
      meta('meta[name="author"]')).slice(0, 128) || undefined,
    artworkUrl,
    pageUrl: absoluteUrl(location.href),
    secondaryUrl,
    secondaryLabel,
    playback: selected ? {
      position: selected.currentTime,
      duration: selected.duration,
      paused: selected.paused,
      rate: selected.playbackRate,
      observedAt: Date.now()
    } : undefined,
    embedOrigins,
    embedFrames
  };
}
