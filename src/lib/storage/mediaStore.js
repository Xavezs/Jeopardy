/* =========================================================================
   MEDIA STORE (IndexedDB)
   Large media (images/video/audio uploaded as files) is stored here as raw
   Blobs, NOT as base64 in localStorage. localStorage caps out around
   5-10MB total per origin, and a base64-encoded video can blow past that
   on its own, causing saves to silently fail. IndexedDB has no such
   practical limit (typically hundreds of MB or more, browser-dependent).

   Clue objects only ever hold a small string reference like
   "media:media_abc123" — never the blob itself. getMediaUrl() resolves
   that reference back into something a <img>/<video>/<audio> tag can use.
   ========================================================================= */
const MEDIA_DB_NAME = "jp_media_db";
const MEDIA_DB_VERSION = 1;
const MEDIA_STORE_NAME = "media";
const MEDIA_REF_PREFIX = "media:";

let mediaDbPromise = null;
function openMediaDB() {
  if (mediaDbPromise) return mediaDbPromise;
  mediaDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available in this browser/context"));
      return;
    }
    const req = indexedDB.open(MEDIA_DB_NAME, MEDIA_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MEDIA_STORE_NAME)) {
        db.createObjectStore(MEDIA_STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return mediaDbPromise;
}

export const MediaStore = {
  // Stores a File/Blob, returns a reference string to save on the clue (e.g. "media:media_abc123")
  async put(file) {
    const db = await openMediaDB();
    const id = "media_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(MEDIA_STORE_NAME, "readwrite");
      tx.objectStore(MEDIA_STORE_NAME).put({
        id,
        blob: file,
        name: file.name || "",
        type: file.type || "",
        size: file.size || 0,
        createdAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return MEDIA_REF_PREFIX + id;
  },
  async get(id) {
    const db = await openMediaDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MEDIA_STORE_NAME, "readonly");
      const req = tx.objectStore(MEDIA_STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },
  async delete(id) {
    try {
      const db = await openMediaDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(MEDIA_STORE_NAME, "readwrite");
        tx.objectStore(MEDIA_STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      /* best effort — ignore */
    }
  },
};

export function isMediaRef(value) {
  return typeof value === "string" && value.startsWith(MEDIA_REF_PREFIX);
}

/* =========================================================================
   MEDIA TYPE DETECTION
   The clue's editor has a single media field (paste a URL or upload a
   file) instead of separate image/video/audio inputs, so we need to guess
   which kind of media something is.
   - Uploaded files: trust the browser-supplied MIME type (reliable).
   - Pasted URLs: guess from the file extension / YouTube domain.
   Returns "image" | "video" | "audio" | "" (unknown — caller should fall
   back to trying each element type until one works).
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
// - "media:xxx"  -> looks up the blob in IndexedDB, returns an object URL
// - "data:..."   -> legacy inline base64 (from before this fix) — passed through as-is
// - anything else (http(s) URL, YouTube link) -> passed through as-is
// Returns "" if the reference can't be resolved (e.g. blob was cleared/never saved).
export async function getMediaUrl(ref) {
  if (!ref) return "";
  if (isMediaRef(ref)) {
    const id = ref.slice(MEDIA_REF_PREFIX.length);
    try {
      const record = await MediaStore.get(id);
      if (!record || !record.blob) return "";
      return URL.createObjectURL(record.blob);
    } catch (e) {
      return "";
    }
  }
  return ref;
}
