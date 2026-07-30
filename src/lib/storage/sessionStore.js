import { api } from "../api";

/* =========================================================================
   SESSION STORE
   Board CRUD lives on the server, scoped to whoever is logged in via
   Discord. Boards can now be shared: an owner generates a room code via
   inviteToBoard(), a friend uses joinBoard() with that code to get editor
   access, and the board's buzzer can be bound to a Discord voice channel
   via setDiscordChannel() so /buzz there feeds the same room as the web
   Buzz button.

   getCurrentId/setCurrentId are the one exception — "which board did I
   have open last" is local UI convenience, not board data, so that still
   lives in localStorage.
   ========================================================================= */
const CURRENT_KEY = "jp_current_session_id";

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
      timerDuration: 30,
    },
  };
}

export const SessionStore = {
  // GET /api/boards — boards you own or were added to
  async getIndex() {
    return await api("/api/boards");
  },

  async getCurrentId() {
    return localStorage.getItem(CURRENT_KEY);
  },
  async setCurrentId(id) {
    localStorage.setItem(CURRENT_KEY, id);
  },

  // GET /api/boards/:id — now also returns isOwner, roomCode (owner-only), discordChannelId
  async loadSession(id) {
    try {
      return await api("/api/boards/" + id);
    } catch {
      return null;
    }
  },

  async saveSession(session) {
    const result = await api("/api/boards/" + session.id, {
      method: "PUT",
      body: JSON.stringify({ name: session.name, data: session.data }),
    });
    session.updatedAt = result.updatedAt;
    return { degraded: false };
  },

  async deleteSession(id) {
    await api("/api/boards/" + id, { method: "DELETE" });
  },

  async createSession(name, data) {
    return await api("/api/boards", {
      method: "POST",
      body: JSON.stringify({ name, data: data || defaultSessionData() }),
    });
  },

  async duplicateSession(id, newName) {
    try {
      return await api("/api/boards/" + id + "/duplicate", {
        method: "POST",
        body: JSON.stringify({ name: newName }),
      });
    } catch {
      return null;
    }
  },

  // POST /api/boards/:id/invite — owner only. Returns the board's room
  // code, generating one the first time. Share this with a friend so they
  // can join with joinBoard() below.
  async inviteToBoard(id) {
    return await api("/api/boards/" + id + "/invite", { method: "POST" });
  },

  // POST /api/boards/join — a friend enters a room code and gets editor
  // access. Returns the full board (same shape as loadSession()).
  async joinBoard(roomCode) {
    return await api("/api/boards/join", {
      method: "POST",
      body: JSON.stringify({ roomCode }),
    });
  },

  // PUT /api/boards/:id/channel — owner only. Binds/unbinds the Discord
  // voice channel whose /buzz feeds this board's buzzer.
  async setDiscordChannel(id, discordChannelId) {
    return await api("/api/boards/" + id + "/channel", {
      method: "PUT",
      body: JSON.stringify({ discordChannelId }),
    });
  },
};

export function migrateClueSchemaIfNeeded(data) {
  if (!data.settings) data.settings = { timerEnabled: true, timerDuration: 30 };
  if (data.settings.timerEnabled === undefined) data.settings.timerEnabled = true;
  if (!data.settings.timerDuration) data.settings.timerDuration = 30;

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