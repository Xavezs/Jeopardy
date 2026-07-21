import { storeGet, storeSet, storeRemove } from "./kvStore";

/* =========================================================================
   SESSION STORE
   Session CRUD (create/load/save/delete/duplicate) plus the session data
   shape (blank clue/category, default board) and schema migration. Reads
   and writes go through kvStore's storeGet/storeSet/storeRemove — this
   file doesn't touch localStorage directly.
   ========================================================================= */
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
  return {
    question: "",
    answer: "",
    mediaUrl: "",
    mediaType: "",
    answerMediaUrl: "",
    answerMediaType: "",
    used: false,
    timerSeconds: null,
  };
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
        if (clue.answerMediaUrl === undefined) clue.answerMediaUrl = "";
        if (clue.answerMediaType === undefined) clue.answerMediaType = "";
        if (clue.timerSeconds === undefined) clue.timerSeconds = null;
      });
    });
  });
}