import { API_BASE } from "../api";

// MEDIA STORE (Supabase Storage)
const MEDIA_REF_PREFIX = "media:";
const urlCache = new Map();

export const MediaStore = {
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
    }
    urlCache.delete(key);
  },
};

export function isMediaRef(value) {
  return typeof value === "string" && value.startsWith(MEDIA_REF_PREFIX);
}

// GOOGLE DRIVE LINKS
export function isGoogleDriveUrl(url) {
  return typeof url === "string" && /drive\.google\.com/i.test(url);
}

export function extractGoogleDriveFileId(url) {
  if (!url) return "";
  const pathMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (pathMatch) return pathMatch[1];
  const paramMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (paramMatch) return paramMatch[1];
  return "";
}

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

// MEDIA TYPE DETECTION
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
  if (isGoogleDriveUrl(url)) return "";
  const cleaned = url.split(/[?#]/)[0];
  const ext = (cleaned.split(".").pop() || "").toLowerCase();
  for (const [kind, exts] of Object.entries(EXT_MAP)) {
    if (exts.includes(ext)) return kind;
  }
  return "";
}

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
    // No parseable id
    if (!fileId) return "";
    return `${API_BASE}/api/media/gdrive/${fileId}`;
  }
  // Exclude YouTube links from proxying
  const { isYoutubeUrl } = await import("../youtube");
  if (isYoutubeUrl(ref)) {
    return ref;
  }

  if (/^https?:\/\//i.test(ref)) {
    return `${API_BASE}/api/media/proxy?url=${encodeURIComponent(ref)}`;
  }
  return ref;
}