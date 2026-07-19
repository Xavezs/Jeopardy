/* =========================================================================
   KEY-VALUE STORE
   Uses the browser's localStorage so the app persists data on its own.
   Falls back to an in-memory store for the current tab if localStorage is
   unavailable (e.g. private browsing with storage disabled) — but callers
   are told when that fallback happens, since memory-only storage won't
   survive a refresh.
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

export async function storeGet(key) {
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
export async function storeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return { ok: true, degraded: false };
  } catch (e) {
    MemoryStore[key] = value;
    return { ok: true, degraded: true, error: e };
  }
}

export async function storeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    delete MemoryStore[key];
  }
}
