import { useState, useRef, useEffect, useCallback } from "react";
import { SessionStore } from "../storage";

/* =========================================================================
   usePersistence
   Owns just the session STATE and its autosave plumbing (touch/persist/
   flushPersist/saveMsg) — deliberately split out of useSessionManager so it
   has no dependency on useBoardGrid. useSessionManager needs
   board.ensureClueGrid/board.performFlip, and useBoardGrid needs
   sessionRef/touch/persist — this hook is the thing both of those can
   depend on without depending on each other.
   ========================================================================= */
export function usePersistence() {
  const [session, setSession] = useState(null);
  const sessionRef = useRef(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const [saveMsg, setSaveMsg] = useState("");
  const saveMsgTimeout = useRef(null);
  const persistTimeout = useRef(null);

  function touch() {
    setSession((s) => (s ? { ...s } : s));
  }

  const persist = useCallback(() => {
    // Update the UI immediately — don't make clicks wait on a storage write.
    touch();
    clearTimeout(persistTimeout.current);
    persistTimeout.current = setTimeout(async () => {
      const s = sessionRef.current;
      if (!s) return;
      await SessionStore.saveSession(s);
      setSaveMsg('Saved to "' + s.name + '"');
      clearTimeout(saveMsgTimeout.current);
      saveMsgTimeout.current = setTimeout(() => setSaveMsg(""), 1800);
    }, 400);
  }, []);

  const flushPersist = useCallback(async () => {
    if (persistTimeout.current) {
      clearTimeout(persistTimeout.current);
      persistTimeout.current = null;
    }
    const s = sessionRef.current;
    if (s) await SessionStore.saveSession(s);
  }, []);

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (persistTimeout.current) {
        // Best-effort — fires a synchronous-ish save attempt before the tab closes.
        const s = sessionRef.current;
        if (s) SessionStore.saveSession(s);
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  return { session, setSession, sessionRef, touch, persist, flushPersist, saveMsg };
}
