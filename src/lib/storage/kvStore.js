// KEY-VALUE STORE
const MemoryStore = Object.create(null);

export async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      if (already) return true;
      return await navigator.storage.persist();
    }
  } catch (e) {
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
