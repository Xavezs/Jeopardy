/* =========================================================================
   STORAGE LAYER
   Uses the browser's localStorage so the app persists data on its own,
   outside of the Claude artifact environment. Falls back to an in-memory
   store for the current tab if localStorage is unavailable (e.g. private
   browsing with storage disabled).
   ========================================================================= */
const MemoryStore = Object.create(null);

async function storeGet(key) {
  try {
    const v = localStorage.getItem(key);
    return v !== null ? v : null;
  } catch (e) {
    return Object.prototype.hasOwnProperty.call(MemoryStore, key) ? MemoryStore[key] : null;
  }
}
async function storeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    MemoryStore[key] = value;
    return true;
  }
}
async function storeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    delete MemoryStore[key];
  }
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
  return { question: "", answer: "", imageUrl: "", videoUrl: "", audioUrl: "", used: false };
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
  return {
    title: "JEOPARDY",
    values: initialValues,
    categories: ["Category", "Category", "Category", "Category", "Category"].map((n) =>
      blankCategory(n, initialValues)
    ),
    teams: [
      { id: "t1", name: "Team 1", score: 0 },
      { id: "t2", name: "Team 2", score: 0 },
      { id: "t3", name: "Team 3", score: 0 },
    ],
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
    await storeSet(SESSION_KEY(session.id), JSON.stringify(session));
    const index = await this.getIndex();
    const meta = {
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      categoryCount: session.data.categories.length,
      teamCount: session.data.teams.length,
    };
    const idx = index.findIndex((e) => e.id === session.id);
    if (idx >= 0) index[idx] = meta;
    else index.push(meta);
    await this.saveIndex(index);
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
  if (!data.values) data.values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  data.categories.forEach((cat) => {
    data.values.forEach((v) => {
      const clue = cat.clues[v];
      if (!clue) {
        cat.clues[v] = blankClue();
        return;
      }
      if (clue.imageUrl === undefined) clue.imageUrl = "";
      if (clue.videoUrl === undefined) clue.videoUrl = "";
      if (clue.audioUrl === undefined) clue.audioUrl = "";
    });
  });
}
