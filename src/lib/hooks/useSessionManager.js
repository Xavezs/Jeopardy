import { useState, useEffect } from "react";
import { SessionStore, migrateClueSchemaIfNeeded } from "../storage";

export function useSessionManager({ persistence, ensureClueGrid, performFlip, initBgm, onSwitched, appConfirm }) {
  const { session, setSession, sessionRef, touch, persist, flushPersist, saveMsg } = persistence;

  const [ready, setReady] = useState(false);
  const [sessionsModalOpen, setSessionsModalOpen] = useState(false);
  const [sessionIndex, setSessionIndex] = useState([]);

  // INIT
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

      // Load the GLOBAL bgm settings
      await initBgm(loaded.data);

      setReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SESSION SWITCHING
  async function switchToSession(id) {
    if (!sessionRef.current) return;
    await flushPersist();
    const rd = sessionRef.current.data.rounds[sessionRef.current.data.currentRound];

    return performFlip(
      () => Math.max(1, rd?.categories?.length || 0),
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
      () => Math.max(1, rd?.categories?.length || 0),
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

  // SESSIONS MODAL HANDLERS
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
