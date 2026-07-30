import { useState, useEffect } from "react";
import { SessionStore, migrateClueSchemaIfNeeded } from "../storage";

/* =========================================================================
   useSessionManager
   Owns session-LIST operations: init/load/switch/create/rename/duplicate/
   delete, and the sessions-modal open state. Session state itself
   (session/sessionRef/touch/persist/flushPersist/saveMsg) lives in
   usePersistence and is passed in as `persistence` — this hook does not
   create its own copy of it.

   Takes `ensureClueGrid`/`performFlip` (from useBoardGrid) and `initBgm`
   (from useBgmSettings) as plain arguments rather than importing those
   hooks itself, so there's no circular dependency between "sessions" and
   "board"/"bgm". The orchestrator is the only place that wires them
   together.
   ========================================================================= */
export function useSessionManager({ persistence, ensureClueGrid, performFlip, initBgm, onSwitched, appConfirm }) {
  const { session, setSession, sessionRef, touch, persist, flushPersist, saveMsg } = persistence;

  const [ready, setReady] = useState(false);
  const [sessionsModalOpen, setSessionsModalOpen] = useState(false);
  const [sessionIndex, setSessionIndex] = useState([]);

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
      ensureClueGrid(loaded.data);
      setSession(loaded);

      // Load the GLOBAL bgm settings — independent of whichever session just loaded.
      await initBgm(loaded.data);

      setReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- SESSION SWITCHING ---------------- */
  // Same per-cell stagger ripple used for round switching (see useBoardGrid's
  // performFlip): the CURRENT board flips out, then — once both the flip-out
  // animation and the (async) session load have finished — the new board is
  // swapped in and flips back to idle with the same wave.
  async function switchToSession(id) {
    if (!sessionRef.current) return;
    await flushPersist();
    const rd = sessionRef.current.data.rounds[sessionRef.current.data.currentRound];

    return performFlip(
      () => rd.categories.length,
      async () => {
        const loaded = await SessionStore.loadSession(id);
        if (!loaded) return null;
        migrateClueSchemaIfNeeded(loaded.data);
        ensureClueGrid(loaded.data);
        await SessionStore.setCurrentId(id);
        onSwitched({ editMode: false });
        setSession(loaded);
        return loaded;
      }
    );
  }

  async function createAndSwitchToNewSession(name) {
    if (!sessionRef.current) return;
    await flushPersist();
    const rd = sessionRef.current.data.rounds[sessionRef.current.data.currentRound];

    return performFlip(
      () => rd.categories.length,
      async () => {
        const created = await SessionStore.createSession(name);
        await SessionStore.setCurrentId(created.id);
        onSwitched({ editMode: true });
        setSession(created);
        return created;
      }
    );
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

  return {
    ready,
    session,
    sessionRef,
    data: session ? session.data : null,
    saveMsg,
    touch,
    persist,
    flushPersist,
    sessionsModalOpen,
    setSessionsModalOpen,
    sessionIndex,
    openSessionsModal,
    switchToSession,
    createAndSwitchToNewSession,
    handleRenameSessionCommit,
    handleLoadSession,
    handleDuplicateSession,
    handleDeleteSession,
    handleCreateNewSession,
  };
}
