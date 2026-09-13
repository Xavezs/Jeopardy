// lib/youtube.js
//
// Detects whether a pasted media URL points at YouTube and extracts the
// video ID. YouTube links can't be played via <video src> (they're HTML
// pages, not media files) — they need YouTube's own iframe embed player.
export function getYoutubeVideoId(url) {
  if (!url || typeof url !== "string") return null;

  // Match 11-char YouTube video ID from standard watch/embed/shorts links,
  // even if wrapped inside a proxy query parameter like `/api/media/proxy?url=...`
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];

  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, "");

    // https://youtu.be/VIDEOID
    if (host === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return id || null;
    }

    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      // https://www.youtube.com/watch?v=VIDEOID
      if (u.pathname === "/watch") {
        return u.searchParams.get("v");
      }
      // https://www.youtube.com/embed/VIDEOID
      if (u.pathname.startsWith("/embed/")) {
        return u.pathname.split("/")[2] || null;
      }
      // https://www.youtube.com/shorts/VIDEOID
      if (u.pathname.startsWith("/shorts/")) {
        return u.pathname.split("/")[2] || null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function isYoutubeUrl(url) {
  return getYoutubeVideoId(url) !== null;
}

// Returns a same-origin embed URL that goes through Discord's URL Mapping.
// The Activity must have a mapping: /youtube-embed -> https://www.youtube.com
// in the Discord Developer Portal. This makes the iframe same-origin from
// the CSP's perspective, bypassing the frame-src 'self' restriction.
// In local dev, Vite's proxy handles the rewrite instead.
export function getYoutubeEmbedUrl(url) {
  const id = getYoutubeVideoId(url);
  if (!id) return null;
  return `/youtube-embed/embed/${id}`;
}

// Loads the YouTube IFrame Player API script once and resolves with the
// window.YT global once it's ready. Safe to call from multiple components
// mounting at once (question media + answer media, or host + late-joining
// player) — they all await the same promise instead of injecting the
// script twice or racing on window.onYouTubeIframeAPIReady.
//
// IMPORTANT: Discord Activities lock script-src to 'self' (+ a per-load
// nonce) and this CANNOT be extended via a Developer Portal URL Mapping the
// way connect-src/media-src/img-src can. Loading https://www.youtube.com/
// iframe_api directly will always be blocked inside the Activity. Instead
// this fetches it through a same-origin route your own server proxies
// (see bot-server.js: GET /youtube-iframe-api.js), so the browser sees a
// same-origin script and script-src 'self' is satisfied.
let ytApiPromise = null;
export function loadYoutubeIframeApi() {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise((resolve, reject) => {
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prevReady === "function") prevReady();
      resolve(window.YT);
    };

    // Use a cache-buster so that browser or Discord clients don't aggressively
    // cache old versions of this script, ensuring backend changes take effect immediately.
    const baseScriptSrc = "/api/youtube-iframe-api.js";
    const existing = document.querySelector(`script[src^="${baseScriptSrc}"]`);
    if (!existing) {
      const tag = document.createElement("script");
      tag.src = `${baseScriptSrc}?v=${Date.now()}`;
      tag.onerror = () => reject(new Error("Failed to load YouTube IFrame API script (proxy route)"));
      document.head.appendChild(tag);
    }

    // Belt-and-suspenders timeout in case the CSP/proxy silently swallows
    // the script (this is exactly the kind of thing that bit you with the
    // Supabase media CSP — worth failing loud instead of hanging forever).
    setTimeout(() => {
      if (!(window.YT && window.YT.Player)) {
        reject(new Error("YouTube IFrame API did not load in time (possibly blocked by CSP)"));
      }
    }, 8000);
  });

  return ytApiPromise;
}