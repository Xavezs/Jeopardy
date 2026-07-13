import React, { useState, useEffect, useRef, useCallback } from "react";
import "./styles/board.css";
import {
  SessionStore,
  blankClue,
  blankCategory,
  migrateClueSchemaIfNeeded,
  MediaStore,
  isMediaRef,
} from "./lib/storage";
import { formatDate, isDataUrl, humanSize } from "./lib/utils";
import ClueModal from "./components/ClueModal";
import EditClueModal from "./components/EditClueModal";
import SessionsModal from "./components/SessionsModal";
import ConfirmDialog from "./components/ConfirmDialog";

/* =========================================================================
   MAIN APP
   ========================================================================= */
export default function JeopardyBoard() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState(null);
  const sessionRef = useRef(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const [editMode, setEditMode] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const saveMsgTimeout = useRef(null);

  const [activeClue, setActiveClue] = useState(null); // {catId, value}
  const [revealed, setRevealed] = useState(false);

  const [editingTarget, setEditingTarget] = useState(null); // {catId, value}
  const [editForm, setEditForm] = useState({ question: "", answer: "" });
  const [mediaState, setMediaState] = useState({
    image: { mode: "url", url: "", fileRef: "", fileName: "" },
    video: { mode: "url", url: "", fileRef: "", fileName: "" },
    audio: { mode: "url", url: "", fileRef: "", fileName: "" },
  });

  const [sessionsModalOpen, setSessionsModalOpen] = useState(false);
  const [sessionIndex, setSessionIndex] = useState([]);

  const [dialog, setDialog] = useState(null); // {title, message, okLabel, showCancel}
  const dialogResolveRef = useRef(null);

  const data = session ? session.data : null;

  function touch() {
    setSession((s) => (s ? { ...s } : s));
  }

  const persist = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    await SessionStore.saveSession(s);
    setSaveMsg('Saved to "' + s.name + '"');
    clearTimeout(saveMsgTimeout.current);
    saveMsgTimeout.current = setTimeout(() => setSaveMsg(""), 1800);
    touch();
  }, []);

  function showDialog({ title, message, okLabel, showCancel }) {
    return new Promise((resolve) => {
      dialogResolveRef.current = resolve;
      setDialog({ title, message, okLabel, showCancel });
    });
  }
  function appConfirm(message) {
    return showDialog({ title: "Are you sure?", message, okLabel: "Confirm", showCancel: true });
  }
  function appAlert(message) {
    return showDialog({ title: "Heads up", message, okLabel: "OK", showCancel: false });
  }
  function resolveDialog(val) {
    const r = dialogResolveRef.current;
    dialogResolveRef.current = null;
    setDialog(null);
    if (r) r(val);
  }

  /* ---------------- INIT ---------------- */
  useEffect(() => {
    (async () => {
      let index = await SessionStore.getIndex();
      let currentId = await SessionStore.getCurrentId();
      let loaded;
      if (index.length === 0) {
        loaded = await SessionStore.createSession("Session 1");
        await SessionStore.setCurrentId(loaded.id);
      } else {
        const validCurrent = currentId && index.some((e) => e.id === currentId);
        const idToLoad = validCurrent ? currentId : index.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
        loaded = await SessionStore.loadSession(idToLoad);
        await SessionStore.setCurrentId(idToLoad);
      }
      migrateClueSchemaIfNeeded(loaded.data);
      setSession(loaded);
      setReady(true);
    })();
  }, []);

  /* ---------------- SESSION SWITCHING ---------------- */
  async function switchToSession(id) {
    const loaded = await SessionStore.loadSession(id);
    if (!loaded) return;
    migrateClueSchemaIfNeeded(loaded.data);
    await SessionStore.setCurrentId(id);
    setEditMode(false);
    setActiveClue(null);
    setSession(loaded);
  }
  async function createAndSwitchToNewSession(name) {
    const created = await SessionStore.createSession(name);
    await SessionStore.setCurrentId(created.id);
    setEditMode(true);
    setSession(created);
  }

  async function refreshSessionList() {
    const index = (await SessionStore.getIndex()).slice().sort((a, b) => b.updatedAt - a.updatedAt);
    setSessionIndex(index);
  }
  async function openSessionsModal() {
    await refreshSessionList();
    setSessionsModalOpen(true);
  }

  /* ---------------- SESSIONS MODAL HANDLERS ---------------- */
  async function handleRenameSessionCommit(meta, newName) {
    const full = await SessionStore.loadSession(meta.id);
    if (full) {
      full.name = newName || "Untitled Session";
      await SessionStore.saveSession(full);
      if (session.id === meta.id) {
        const s = sessionRef.current;
        s.name = full.name;
        touch();
      }
      refreshSessionList();
    }
  }
  async function handleLoadSession(id) {
    await switchToSession(id);
    setSessionsModalOpen(false);
  }
  async function handleDuplicateSession(id, newName) {
    const copy = await SessionStore.duplicateSession(id, newName);
    if (copy) refreshSessionList();
  }
  async function handleDeleteSession(id, name) {
    if (!(await appConfirm('Delete session "' + name + '"? This cannot be undone.'))) return;
    await SessionStore.deleteSession(id);
    if (session.id === id) {
      const remaining = await SessionStore.getIndex();
      if (remaining.length > 0) await switchToSession(remaining[0].id);
      else await createAndSwitchToNewSession("Session 1");
    }
    refreshSessionList();
  }
  async function handleCreateNewSession() {
    const index = await SessionStore.getIndex();
    await createAndSwitchToNewSession("Session " + (index.length + 1));
    setSessionsModalOpen(false);
  }

  /* ---------------- CATEGORY / ROW ACTIONS ---------------- */
  function renameCategory(cat, name) {
    cat.name = name || "Category";
    persist();
  }
  async function removeCategory(cat) {
    const d = sessionRef.current.data;
    if (d.categories.length <= 1) {
      appAlert("You must keep at least one column category!");
      return;
    }
    if (await appConfirm(`Delete column "${cat.name || "Category"}" and all its contained clues?`)) {
      d.categories = d.categories.filter((c) => c.id !== cat.id);
      touch();
      persist();
    }
  }
  function addCategory() {
    const d = sessionRef.current.data;
    d.categories.push(blankCategory("New Category", d.values));
    touch();
    persist();
  }

  function changeRowValue(oldVal, input) {
    const d = sessionRef.current.data;
    const newVal = parseInt(input, 10);
    if (isNaN(newVal) || newVal <= 0 || d.values.includes(newVal)) {
      touch(); // revert silently, no popup needed for a simple field edit
      return;
    }
    const oldIndex = d.values.indexOf(oldVal);
    d.values[oldIndex] = newVal;
    d.categories.forEach((c) => {
      if (c.clues[oldVal]) {
        c.clues[newVal] = c.clues[oldVal];
        delete c.clues[oldVal];
      }
    });
    d.values.sort((a, b) => a - b);
    touch();
    persist();
  }
  async function removeRow(v) {
    const d = sessionRef.current.data;
    if (d.values.length <= 1) {
      appAlert("You must keep at least one row!");
      return;
    }
    if (await appConfirm(`Remove the entire $${v} row? All clue data inside it across columns will be lost.`)) {
      d.values = d.values.filter((val) => val !== v);
      d.categories.forEach((c) => {
        delete c.clues[v];
      });
      touch();
      persist();
    }
  }
  function addRow() {
    const d = sessionRef.current.data;
    let nextVal = 100;
    if (d.values && d.values.length > 0) nextVal = Math.max(...d.values) + 100;
    while (d.values.includes(nextVal)) nextVal += 100;
    d.values.push(nextVal);
    d.values.sort((a, b) => a - b);
    d.categories.forEach((c) => {
      c.clues[nextVal] = blankClue();
    });
    touch();
    persist();
  }

  /* ---------------- TEAM ACTIONS ---------------- */
  function renameTeam(team, name) {
    team.name = name || "Team";
    persist();
  }
  function adjustTeamScore(team, delta) {
    team.score += delta;
    touch();
    persist();
  }
  function setTeamScore(team, rawValue) {
    const parsed = parseInt(rawValue, 10);
    team.score = Number.isNaN(parsed) ? 0 : parsed;
    touch();
    persist();
  }
  function addTeam() {
    const d = sessionRef.current.data;
    d.teams.push({ id: "t_" + Math.random().toString(36).slice(2, 9), name: "Team " + (d.teams.length + 1), score: 0 });
    touch();
    persist();
  }
  function removeTeam(team) {
    const d = sessionRef.current.data;
    d.teams = d.teams.filter((t) => t.id !== team.id);
    touch();
    persist();
  }

  /* ---------------- CLUE PLAY MODAL ---------------- */
  function openClueModal(cat, value) {
    setActiveClue({ catId: cat.id, value });
    setRevealed(false);
  }
  function closeClueModal(markUsed) {
    if (markUsed && activeClue) {
      const d = sessionRef.current.data;
      const cat = d.categories.find((c) => c.id === activeClue.catId);
      if (cat) cat.clues[activeClue.value].used = true;
      touch();
      persist();
    }
    setActiveClue(null);
  }

  /* ---------------- CLUE EDIT MODAL ---------------- */
  function openEditModal(cat, value) {
    const clue = cat.clues[value];
    setEditingTarget({ catId: cat.id, value });
    setEditForm({ question: clue.question || "", answer: clue.answer || "" });
    const next = {};
    ["image", "video", "audio"].forEach((type) => {
      const existing = clue[type + "Url"] || "";
      if (isMediaRef(existing) || isDataUrl(existing)) {
        next[type] = { mode: "file", url: "", fileRef: existing, fileName: "File attached (from earlier) — remove to replace" };
      } else {
        next[type] = { mode: "url", url: existing, fileRef: "", fileName: "" };
      }
    });
    setMediaState(next);
  }
  function closeEditModal() {
    setEditingTarget(null);
  }
  async function handleMediaFile(type, file) {
    if (!file) return;
    // IndexedDB comfortably handles much larger files than the old base64/localStorage
    // approach did — this warning is now just a courtesy for very large uploads.
    const proceed =
      file.size < 50 * 1024 * 1024 ||
      (await appConfirm(`"${file.name}" is ${humanSize(file.size)}. That's a large file — it may take a moment to store. Use it anyway?`));
    if (!proceed) return;
    try {
      const ref = await MediaStore.put(file);
      setMediaState((prev) => ({
        ...prev,
        [type]: { mode: "file", url: "", fileRef: ref, fileName: `📎 ${file.name} (${humanSize(file.size)})` },
      }));
    } catch (e) {
      appAlert("Could not store that file — your browser may be blocking local storage (e.g. private browsing mode).");
    }
  }
  function clearMediaField(type) {
    setMediaState((prev) => ({ ...prev, [type]: { mode: "url", url: "", fileRef: "", fileName: "" } }));
  }
  function saveClue() {
    if (!editingTarget) return;
    const d = sessionRef.current.data;
    const cat = d.categories.find((c) => c.id === editingTarget.catId);
    if (cat) {
      const clue = cat.clues[editingTarget.value];
      clue.question = editForm.question.trim();
      clue.answer = editForm.answer.trim();
      ["image", "video", "audio"].forEach((type) => {
        const m = mediaState[type];
        clue[type + "Url"] = m.mode === "file" ? m.fileRef : m.url.trim();
      });
      touch();
      persist();
    }
    setEditingTarget(null);
  }

  /* ---------------- RESET ROUND ---------------- */
  async function resetRound() {
    if (!(await appConfirm("Reset all scores to 0 and mark all clues unused in this session? Your questions/answers/media stay."))) return;
    const d = sessionRef.current.data;
    d.categories.forEach((cat) => {
      d.values.forEach((v) => {
        if (cat.clues[v]) cat.clues[v].used = false;
      });
    });
    d.teams.forEach((t) => (t.score = 0));
    touch();
    persist();
  }

  if (!ready || !data) {
    return (
      <div className="jp-root" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "var(--text-dim)", fontSize: 13 }}>Loading board…</div>
      </div>
    );
  }

  const nCats = data.categories.length;
  const nRows = data.values.length;
  const boardGridStyle = editMode
    ? { gridTemplateColumns: `74px repeat(${nCats}, minmax(0, 1fr)) 67px`, gridTemplateRows: `74px repeat(${nRows}, minmax(0, 1fr)) 67px` }
    : { gridTemplateColumns: `repeat(${nCats}, minmax(0, 1fr))`, gridTemplateRows: `auto repeat(${nRows}, minmax(0, 1fr))` };

  const activeCat = activeClue ? data.categories.find((c) => c.id === activeClue.catId) : null;
  const activeClueObj = activeCat && activeClue ? activeCat.clues[activeClue.value] : null;

  const editingCat = editingTarget ? data.categories.find((c) => c.id === editingTarget.catId) : null;

  return (
    <div className="jp-root">
      <div className="marquee">
        <input
          className="marquee-title"
          maxLength={40}
          disabled={!editMode}
          defaultValue={data.title}
          key={"title-" + session.id}
          onBlur={(e) => {
            data.title = e.target.value || "GAME NIGHT";
            persist();
          }}
        />
      </div>
      <div className="session-bar">
        Session: <b>{session.name}</b> · last saved {formatDate(session.updatedAt)}
      </div>

      <div className="toolbar">
        <button className="btn gold" onClick={() => setEditMode((v) => !v)}>
          {editMode ? "✓ Done Editing" : "✎ Edit Board"}
        </button>
        <button className="btn" onClick={openSessionsModal}>
          Sessions
        </button>
        <button className="btn" onClick={resetRound}>
          ↺ Reset Round (keep content)
        </button>
      </div>
      <div className="edit-banner">
        {editMode ? "EDIT MODE — click any cell to edit its clue, edit headers, or add/delete rows and columns" : ""}
      </div>

      <div id="boardWrap">
        <div id="board" style={boardGridStyle}>
          {data.categories.map((cat, catIndex) => (
            <div
              key={cat.id}
              className="cat-cell"
              style={{ gridRow: "1", gridColumn: editMode ? catIndex + 2 : catIndex + 1 }}
            >
              {editMode ? (
                <>
                  <input
                    className="cat-name-input"
                    maxLength={30}
                    defaultValue={cat.name}
                    key={cat.id + "-name"}
                    onBlur={(e) => renameCategory(cat, e.target.value)}
                  />
                  <button className="cat-remove" title="Remove this category" onClick={() => removeCategory(cat)}>
                    ✕
                  </button>
                </>
              ) : (
                <div className="cat-name">{cat.name}</div>
              )}
            </div>
          ))}

          {editMode && (
            <div className="grid-add-column-cell" style={{ gridColumn: nCats + 2, gridRow: `1 / span ${nRows + 1}` }}>
              <button title="Add Category Column" onClick={addCategory}>
                +
              </button>
            </div>
          )}

          {data.values.map((v, rowIndex) => {
            const gridRowPosition = rowIndex + 2;
            return (
              <React.Fragment key={v}>
                {editMode && (
                  <div className="row-control-cell" style={{ gridRow: gridRowPosition, gridColumn: 1 }}>
                    <input
                      className="row-value-input"
                      type="number"
                      min="1"
                      defaultValue={v}
                      key={v + "-value"}
                      title="Point value for this row"
                      onBlur={(e) => changeRowValue(v, e.target.value)}
                    />
                    <button className="row-delete-btn" title="Delete this row value pattern" onClick={() => removeRow(v)}>
                      <span className="icon">✕</span>
                      <span>Delete</span>
                    </button>
                  </div>
                )}

                {data.categories.map((cat, catIndex) => {
                  if (!cat.clues[v]) cat.clues[v] = blankClue();
                  const clue = cat.clues[v];
                  return (
                    <div
                      key={cat.id + "-" + v}
                      className={"clue-cell" + (clue.used ? " used" : "") + (editMode ? " edit-mode-cell" : "")}
                      style={{ gridRow: gridRowPosition, gridColumn: editMode ? catIndex + 2 : catIndex + 1 }}
                      onClick={() => {
                        if (editMode) openEditModal(cat, v);
                        else if (!clue.used) openClueModal(cat, v);
                      }}
                    >
                      <div className="clue-value">${v}</div>
                      {(clue.imageUrl || clue.videoUrl || clue.audioUrl) && <div className="media-dot">●</div>}
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })}

          {editMode && (
            <div className="grid-add-row-cell" style={{ gridColumn: `1 / span ${nCats + 1}`, gridRow: nRows + 2 }}>
              <button title="Add Value Row" onClick={addRow}>
                +
              </button>
            </div>
          )}
        </div>
      </div>

      <div id="teamsWrap">
        {data.teams.map((team) => (
          <div key={team.id} className="team-card">
            {editMode && (
              <button className="team-remove" title="Remove this team" onClick={() => removeTeam(team)}>
                ✕
              </button>
            )}
            <input
              className="team-name-input"
              disabled={!editMode}
              defaultValue={team.name}
              key={team.id + "-name"}
              onBlur={(e) => renameTeam(team, e.target.value)}
            />
            <div className="team-score-row">
              <button className="plus" onClick={() => adjustTeamScore(team, 100)}>
                +
              </button>
              {editMode ? (
                <input
                  className="team-score-display team-score-input"
                  type="number"
                  defaultValue={team.score}
                  key={team.id + "-score"}
                  title="Set this team's score manually"
                  onBlur={(e) => setTeamScore(team, e.target.value)}
                />
              ) : (
                <div className="team-score-display">{team.score}</div>
              )}
              <button className="minus" onClick={() => adjustTeamScore(team, -100)}>
                −
              </button>
            </div>
          </div>
        ))}
        {editMode && (
          <div className="team-add-card">
            <button title="Add Team" onClick={addTeam}>
              +
            </button>
          </div>
        )}
      </div>

      <div className="save-indicator">{saveMsg || "\u00A0"}</div>

      {activeClue && activeCat && activeClueObj && (
        <ClueModal
          activeCat={activeCat}
          value={activeClue.value}
          clue={activeClueObj}
          teams={data.teams}
          revealed={revealed}
          onToggleReveal={() => setRevealed((r) => !r)}
          onClose={closeClueModal}
          onAdjustTeamScore={adjustTeamScore}
        />
      )}

      {editingTarget && editingCat && (
        <EditClueModal
          editForm={editForm}
          setEditForm={setEditForm}
          mediaState={mediaState}
          setMediaState={setMediaState}
          onMediaFile={handleMediaFile}
          onClearMedia={clearMediaField}
          onSave={saveClue}
          onClose={closeEditModal}
        />
      )}

      {sessionsModalOpen && (
        <SessionsModal
          session={session}
          sessionIndex={sessionIndex}
          onClose={() => setSessionsModalOpen(false)}
          onLoad={handleLoadSession}
          onDuplicate={handleDuplicateSession}
          onDelete={handleDeleteSession}
          onCreateNew={handleCreateNewSession}
          onRenameCommit={handleRenameSessionCommit}
        />
      )}

      <ConfirmDialog dialog={dialog} onResolve={resolveDialog} />
    </div>
  );
}