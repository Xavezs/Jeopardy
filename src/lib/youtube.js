export function getYoutubeVideoId(url) {
  if (!url || typeof url !== "string") return null;

  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];

  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return id || null;
    }

    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (u.pathname === "/watch") {
        return u.searchParams.get("v");
      }
      if (u.pathname.startsWith("/embed/")) {
        return u.pathname.split("/")[2] || null;
      }
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

export function getYoutubeEmbedUrl(url) {
  const id = getYoutubeVideoId(url);
  if (!id) return null;
  return `/youtube-embed/embed/${id}`;
}

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

    const baseScriptSrc = "/api/youtube-iframe-api.js";
    const existing = document.querySelector(`script[src^="${baseScriptSrc}"]`);
    if (!existing) {
      const tag = document.createElement("script");
      tag.src = `${baseScriptSrc}?v=${Date.now()}`;
      tag.onerror = () => reject(new Error("Failed to load YouTube IFrame API script (proxy route)"));
      document.head.appendChild(tag);
    }

    setTimeout(() => {
      if (!(window.YT && window.YT.Player)) {
        reject(new Error("YouTube IFrame API did not load in time (possibly blocked by CSP)"));
      }
    }, 8000);
  });

  return ytApiPromise;
}