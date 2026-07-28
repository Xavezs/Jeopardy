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
  return ref;
}