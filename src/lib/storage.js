/* =========================================================================
   STORAGE LAYER
   Uses the browser's localStorage so the app persists data on its own,
   outside of the Claude artifact environment. Falls back to an in-memory
   store for the current tab if localStorage is unavailable (e.g. private
   browsing with storage disabled) — but callers are told when that
   fallback happens, since memory-only storage won't survive a refresh.
   ========================================================================= */
const MemoryStore = Object.create(null);

// Ask the browser to mark this origin's storage as "persistent" so it's
// exempt from silent eviction under disk pressure (the browser can still
// clear "best-effort" storage on its own if the device runs low on space).
// This is a permission request only — it never reads/writes/moves any
// existing data, so there's nothing to lose by calling it. Safe to call
// once at app startup; no-op (resolves false) in browsers that don't
// support the Storage API.
export async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      if (already) return true;
      return await navigator.storage.persist();
    }
  } catch (e) {
    /* best effort — ignore */
  }
  return false;
}

async function storeGet(key) {
  try {
    const v = localStorage.getItem(key);
    return v !== null ? v : null;
  } catch (e) {
    return Object.prototype.hasOwnProperty.call(MemoryStore, key) ? MemoryStore[key] : null;
  }
}
// Returns { ok, degraded } instead of a bare boolean:
// - ok: true whenever the value is stored somewhere (localStorage OR memory)
// - degraded: true only when it landed in memory because localStorage
//   failed (quota exceeded, private mode, disabled, etc.) — meaning it
//   will NOT survive a refresh/tab close. Callers should warn on this.
async function storeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return { ok: true, degraded: false };
  } catch (e) {
    MemoryStore[key] = value;
    return { ok: true, degraded: true, error: e };
  }
}
async function storeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    delete MemoryStore[key];
  }
}

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
   The clue's editor now has a single media field (paste a URL or upload a
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

const INDEX_KEY = "jp_sessions_index";
const CURRENT_KEY = "jp_current_session_id";
const SESSION_KEY = (id) => "jp_session_" + id;

export function newId() {
  return "sess_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}
export function timestamp() {
  return Date.now();
}

export function blankClue() {
  return { question: "", answer: "", mediaUrl: "", mediaType: "", used: false, timerSeconds: null };
}
export function blankCategory(name, valuesArray) {
  const targetValues = valuesArray || [100, 200, 300, 400, 500];
  return {
    id: "cat_" + Math.random().toString(36).slice(2, 9),
    name,
    clues: targetValues.reduce((acc, v) => {
      acc[v] = blankClue();
      return acc;
    }, {}),
  };
}
export function defaultSessionData() {
  const initialValues = [100, 200, 300, 400, 500];
  const doubleValues = initialValues.map((v) => v * 2);
  const catNames = ["Category", "Category", "Category", "Category", "Category"];
  return {
    title: "JEOPARDY",
    rounds: [
      { name: "Normal Jeopardy", values: initialValues, categories: catNames.map((n) => blankCategory(n, initialValues)) },
      { name: "Double Jeopardy", values: doubleValues, categories: catNames.map((n) => blankCategory(n, doubleValues)) },
    ],
    currentRound: 0,
    teams: [
      { id: "t1", name: "Team 1", score: 0 },
      { id: "t2", name: "Team 2", score: 0 },
      { id: "t3", name: "Team 3", score: 0 },
    ],
    settings: {
      timerEnabled: true,
      timerDuration: 30, // global default, in seconds — per-clue timerSeconds overrides this
    },
  };
}

export const SessionStore = {
  async getIndex() {
    const raw = await storeGet(INDEX_KEY);
    return raw ? JSON.parse(raw) : [];
  },
  async saveIndex(index) {
    await storeSet(INDEX_KEY, JSON.stringify(index));
  },
  async getCurrentId() {
    return await storeGet(CURRENT_KEY);
  },
  async setCurrentId(id) {
    await storeSet(CURRENT_KEY, id);
  },
  async loadSession(id) {
    const raw = await storeGet(SESSION_KEY(id));
    return raw ? JSON.parse(raw) : null;
  },
  async saveSession(session) {
    session.updatedAt = timestamp();
    const result = await storeSet(SESSION_KEY(session.id), JSON.stringify(session));
    const index = await this.getIndex();
    const meta = {
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      categoryCount: session.data.rounds.reduce((sum, r) => sum + r.categories.length, 0),
      roundCount: session.data.rounds.length,
      teamCount: session.data.teams.length,
    };
    const idx = index.findIndex((e) => e.id === session.id);
    if (idx >= 0) index[idx] = meta;
    else index.push(meta);
    await this.saveIndex(index);
    // degraded === true means this save only landed in memory (localStorage
    // failed) and will be LOST on refresh/tab close — surface it to the UI.
    return { degraded: result.degraded };
  },
  async deleteSession(id) {
    await storeRemove(SESSION_KEY(id));
    const index = (await this.getIndex()).filter((e) => e.id !== id);
    await this.saveIndex(index);
  },
  async createSession(name, data) {
    const session = {
      id: newId(),
      name,
      createdAt: timestamp(),
      updatedAt: timestamp(),
      data: data || defaultSessionData(),
    };
    await this.saveSession(session);
    return session;
  },
  async duplicateSession(id, newName) {
    const original = await this.loadSession(id);
    if (!original) return null;
    const copy = {
      id: newId(),
      name: newName,
      createdAt: timestamp(),
      updatedAt: timestamp(),
      data: JSON.parse(JSON.stringify(original.data)),
    };
    await this.saveSession(copy);
    return copy;
  },
};

export function migrateClueSchemaIfNeeded(data) {
  if (!data.settings) data.settings = { timerEnabled: true, timerDuration: 30 };
  if (data.settings.timerEnabled === undefined) data.settings.timerEnabled = true;
  if (!data.settings.timerDuration) data.settings.timerDuration = 30;

  // --- Introduce `rounds` (Double Jeopardy support) ---
  // Older sessions store a single flat board as data.categories/data.values.
  // Wrap that existing board as round 1 ("Single Jeopardy") exactly as-is —
  // nothing about it is touched or regenerated — and add a brand new,
  // blank round 2 ("Double Jeopardy") with the same row count but doubled
  // point values, matching real Jeopardy's format.
  if (!data.rounds) {
    const legacyValues = data.values || [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const legacyCategories =
      data.categories || ["Category", "Category", "Category", "Category", "Category"].map((n) => blankCategory(n, legacyValues));
    const doubleValues = legacyValues.map((v) => v * 2);
    data.rounds = [
      { name: "Normal Jeopardy", values: legacyValues, categories: legacyCategories },
      {
        name: "Double Jeopardy",
        values: doubleValues,
        categories: ["Category", "Category", "Category", "Category", "Category"].map((n) => blankCategory(n, doubleValues)),
      },
    ];
    delete data.categories;
    delete data.values;
  }
  if (data.currentRound === undefined || data.currentRound === null || !data.rounds[data.currentRound]) {
    data.currentRound = 0;
  }

  data.rounds.forEach((round) => {
    if (!round.values) round.values = [100, 200, 300, 400, 500];
    if (!round.categories) round.categories = [];
    round.categories.forEach((cat) => {
      round.values.forEach((v) => {
        const clue = cat.clues[v];
        if (!clue) {
          cat.clues[v] = blankClue();
          return;
        }
        // Migrate from the old three-field (imageUrl/videoUrl/audioUrl) schema
        // to a single mediaUrl/mediaType. If a clue had more than one set
        // (the old editor allowed combos), keep just one — image, then
        // video, then audio — since a clue can now only hold one media item.
        if (clue.mediaUrl === undefined) {
          const legacy = [
            ["image", clue.imageUrl],
            ["video", clue.videoUrl],
            ["audio", clue.audioUrl],
          ].find(([, url]) => url);
          clue.mediaUrl = legacy ? legacy[1] : "";
          clue.mediaType = legacy ? legacy[0] : "";
          delete clue.imageUrl;
          delete clue.videoUrl;
          delete clue.audioUrl;
        }
        if (clue.mediaType === undefined) clue.mediaType = "";
        if (clue.timerSeconds === undefined) clue.timerSeconds = null;
      });
    });
  });
}