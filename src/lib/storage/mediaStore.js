import { API_BASE } from "../api";

/* =========================================================================
   MEDIA STORE (Supabase Storage)
   The browser posts the file to our own server (multipart/form-data),
   which uploads it to Supabase Storage using the service key and hands
   back a public URL. Unlike the R2 presigned-URL version, this doesn't
   need any bucket CORS configuration — the tradeoff is the file passes
   through your server once instead of going straight to storage.

   Clue objects still only ever hold a small string reference like
   "media:<ownerId>/<key>" — never the blob, never the full URL.
   getMediaUrl() resolves that reference into a real https:// URL.
   ========================================================================= */
const MEDIA_REF_PREFIX = "media:";
const urlCache = new Map(); // key -> publicUrl, populated right after upload

export const MediaStore = {
  // Stores a File, returns a reference string to save on the clue
  // (e.g. "media:abc123/xyz_photo.png")
  async put(file) {
    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch(API_BASE + "/api/media/upload", {
      method: "POST",
      credentials: "include",
      body: formData,
    });
    if (res.status === 401) throw new Error("Not logged in");
    if (!res.ok) throw new Error("Upload failed: " + res.status);

    const { key } = await res.json();
    return MEDIA_REF_PREFIX + key;
  },

  async delete(ref) {
    if (!isMediaRef(ref)) return;
    const key = ref.slice(MEDIA_REF_PREFIX.length);
    try {
      await fetch(API_BASE + "/api/media/" + key, {
        method: "DELETE",
        credentials: "include",
      });
    } catch (e) {
      /* best effort — ignore */
    }
    urlCache.delete(key);
  },
};

export function isMediaRef(value) {
  return typeof value === "string" && value.startsWith(MEDIA_REF_PREFIX);
}

/* =========================================================================
   GOOGLE DRIVE LINKS
   A Drive share link never has a useful file extension (e.g.
   ".../file/d/1AbC.../view"), so unlike a plain URL we can't sniff
   image/video/audio from the link itself. That's fine — ClueModal already
   falls back image -> video -> audio on load error (see its onError
   chain), so detectMediaTypeFromUrl() below intentionally returns "" for
   Drive links and lets that existing cascade sort it out at render time.
   ========================================================================= */
export function isGoogleDriveUrl(url) {
  return typeof url === "string" && /drive\.google\.com/i.test(url);
}

// Pulls the file id out of the handful of share-link shapes Drive hands out:
//   https://drive.google.com/file/d/<ID>/view?usp=sharing
//   https://drive.google.com/open?id=<ID>
//   https://drive.google.com/uc?export=download&id=<ID>
export function extractGoogleDriveFileId(url) {
  if (!url) return "";
  const pathMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (pathMatch) return pathMatch[1];
  const paramMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (paramMatch) return paramMatch[1];
  return "";
}

// Asks the server for a Drive file's real mimeType (via the metadata route,
// not alt=media — no file body downloaded) and buckets it into
// "image"/"video"/"audio". Returns "" if the lookup fails or the type is
// something else entirely (e.g. a PDF) — callers should fall back to the
// existing image->video->audio guess cascade in that case.
export async function resolveGoogleDriveMediaType(fileId) {
  if (!fileId) return "";
  try {
    const res = await fetch(`${API_BASE}/api/media/gdrive/${fileId}/meta`);
    if (!res.ok) return "";
    const { mimeType } = await res.json();
    const kind = (mimeType || "").split("/")[0];
    return kind === "image" || kind === "video" || kind === "audio" ? kind : "";
  } catch {
    return "";
  }
}

/* =========================================================================
   MEDIA TYPE DETECTION — unchanged, doesn't touch storage at all
   ========================================================================= */
const EXT_MAP = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "avif"],
  video: ["mp4", "webm", "ogv", "mov", "m4v"],
  audio: ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "weba"],
};

export function detectMediaTypeFromFile(file) {
  if (!file) return "";
  const mime = (file.type || "").split("/")[0];
  if (mime === "image" || mime === "video" || mime === "audio") return mime;
  return detectMediaTypeFromUrl(file.name || "");
}

export function detectMediaTypeFromUrl(url) {
  if (!url) return "";
  if (/youtu\.?be/i.test(url)) return "video";
  if (isGoogleDriveUrl(url)) return ""; // see note above — resolved by ClueModal's fallback cascade instead
  const cleaned = url.split(/[?#]/)[0];
  const ext = (cleaned.split(".").pop() || "").toLowerCase();
  for (const [kind, exts] of Object.entries(EXT_MAP)) {
    if (exts.includes(ext)) return kind;
  }
  return "";
}

// Resolves ANY stored clue media value into something an <img>/<video>/<audio> src can use:
// - "media:xxx"  -> Supabase public URL, from cache (populated on upload
//                   this session) or reconstructed from SUPABASE public
//                   base + bucket if not cached (e.g. a fresh page load)
// - "data:..."   -> legacy inline base64 — passed through as-is
// - anything else (http(s) URL, YouTube link) -> passed through as-is
export async function getMediaUrl(ref) {
  if (!ref) return "";
  if (isMediaRef(ref)) {
    const key = ref.slice(MEDIA_REF_PREFIX.length);
    if (urlCache.has(key)) return urlCache.get(key);

    const bucket = import.meta.env.VITE_SUPABASE_BUCKET || "jeopardy-media";
    const insideDiscord = window.location.hostname.endsWith("discordsays.com");
    const base = insideDiscord ? "/.proxy/supabase" : import.meta.env.VITE_SUPABASE_URL;
    const url = base ? `${base}/storage/v1/object/public/${bucket}/${key}` : "";

    urlCache.set(key, url);
    return url;
  }
  if (isGoogleDriveUrl(ref)) {
    const fileId = extractGoogleDriveFileId(ref);
    // No parseable id -- most commonly a folder link ("/drive/folders/...")
    // instead of a link to one specific file. That could never load here
    // anyway (folders aren't in the CSP allowlist and have no single file
    // to proxy), so return "" rather than the raw link, which would just
    // fail with a confusing raw cross-origin fetch error instead of a
    // clean "no media" state.
    if (!fileId) return "";
    // Same-origin proxy on our own server (like /api/media/upload above),
    // so it just needs API_BASE — no discordsays.com special-casing needed,
    // that's only required when hitting a third-party host like supabase.co
    // directly instead of going through our own server.
    return `${API_BASE}/api/media/gdrive/${fileId}`;
  }
  // Any other plain http(s) link (news CDNs, imgur, random image hosts...):
  // route it through our own server too. Discord's Activity CSP only
  // allowlists 'self', discordsays.com, and a couple of discordapp.com
  // hosts for img-src/media-src/connect-src, so a raw third-party URL gets
  // blocked outright rather than actually failing to load — same-origin
  // proxying is the only way to get it past that CSP.
  if (/^https?:\/\//i.test(ref)) {
    return `${API_BASE}/api/media/proxy?url=${encodeURIComponent(ref)}`;
  }
  return ref;
}