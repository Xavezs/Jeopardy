import { useState, useRef, useEffect, useCallback } from "react";
import { useSocket } from "../SocketContext";
import { SessionStore } from "../storage";

// A board can disappear out from under an open session — deleted by its
// owner from another device/tab, a delete that succeeded server-side even
// though the client never got a clean response, etc. Saving against a
// board id the server no longer has returns 404 "Not found" (boards.js's
// requireRole finds no matching row, so role is null, which maps to 404 —
// see requireRole in boards.js). Left unhandled, that 404 propagates
// straight out of flushPersist/persist and aborts whatever called them —
// most visibly createAndSwitchToNewSession, whose very first step is
// flushPersist()'ing the CURRENTLY open (now-deleted) board before it can
// even attempt to create the new one. Treat "board no longer exists" as
// nothing left to save, not a failure worth propagating.
function isBoardGoneError(err) {
  const msg = String(err?.message || "");
  return err?.status === 404 || /not found/i.test(msg);
}
async function saveSessionTolerant(s) {
  try {
    await SessionStore.saveSession(s);
    return true;
  } catch (err) {
    if (isBoardGoneError(err)) {
      console.warn('Skipped saving "' + s.name + '" — this board no longer exists on the server.');
      return false;
    }
    throw err;
  }
}

/* =========================================================================
   usePersistence
   Owns session STATE and its autosave plumbing. Role-aware via `isHost`:
   only the host emits 'boardUpdate' on connect or save, preventing non-host
   clients or secondary test windows from clobbering active room state.

   Shares the tab's single socket via SocketContext (see SocketContext.jsx)
   instead of opening its own connection. `socketRef` still exists and is
   kept in sync with the shared socket — everything below (persist,
   setRoomCode, rotateRoomCode) reads through the ref exactly like before,
   so none of that logic needed to change.
   ========================================================================= */
export function usePersistence(isHost = true) {
  const [session, setSession] = useState(null);
  const sessionRef = useRef(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const isHostRef = useRef(isHost);
  useEffect(() => {
    isHostRef.current = isHost;
  }, [isHost]);

  const [saveMsg, setSaveMsg] = useState("");
  const saveMsgTimeout = useRef(null);
  const persistTimeout = useRef(null);

  // --- live sync ---
  const { socket } = useSocket();
  const socketRef = useRef(null);
  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);
  const roomCodeRef = useRef(null);

  // Recently-deleted team names (lowercased) -> deletion timestamp. Lets the
  // boardUpdate merge below tell "zombie of a team we just deleted" apart
  // from "legitimately new team from a joining player" — both show up as
  // an unrecognized team ID, but only one of them should survive the merge.
  // Self-expiring so it can't grow unbounded across a long session.
  const deletedTeamNames = useRef(new Map());
  const TOMBSTONE_MS = 15000;
  const markTeamDeleted = useCallback((name) => {
    if (!name) return;
    deletedTeamNames.current.set(name.trim().toLowerCase(), Date.now());
  }, []);

  // Mirror image of the tombstone above: recently-added-locally team IDs.
  // The host round-trips a newly-added team to the server on a 400ms
  // debounce, so there's a brief window where our own brand-new team
  // exists locally but not yet in the server's copy. If a disconnect
  // grace-period cleanup (or anyone else's) boardUpdate lands in that
  // window, its team list won't include our new team either — without
  // this guard the "server no longer has it, so remove it locally" logic
  // below would delete a team we just created before it ever got saved.
  const recentlyAddedTeamIds = useRef(new Map());
  const RECENT_ADD_MS = 5000;
  const markTeamAdded = useCallback((id) => {
    if (!id) return;
    recentlyAddedTeamIds.current.set(id, Date.now());
  }, []);

  // Connected players, as broadcast by the server on join/disconnect
  // (playersUpdate). Carries Discord identity (username/avatarUrl) per
  // connected socket, plus a `connected` flag during the server's
  // disconnect grace period — used as a fallback source for team avatars
  // when live voice-presence data isn't available.
  const [players, setPlayers] = useState([]);

  useEffect(() => {
    if (!socket) return;

    const handleConnect = () => {
      const roomCode = roomCodeRef.current;
      if (!roomCode) return;
      socket.emit("joinRoom", { roomCode, role: "host" });
      const s = sessionRef.current;
      if (s && isHostRef.current) {
        socket.emit("boardUpdate", {
          roomCode,
          data: s.data,
          updatedAt: s.updatedAt,
        });
      }
    };

    const handlePlayersUpdate = (list) => {
      setPlayers(Array.isArray(list) ? list : []);
    };

    // Applying a remote update goes straight into setSession, deliberately
    // NOT through persist()/touch() — so receiving one never triggers a
    // save or a rebroadcast.
    const handleBoardUpdate = ({ data, updatedAt }) => {
      const s = sessionRef.current;
      if (!s) return;

      // The host owns board content, so we don't want to blanket-adopt a
      // remote payload here — that could stomp in-progress edits with a
      // stale broadcast. BUT the server can also push a boardUpdate on its
      // own: when a joining player is auto-assigned to a team
      // (joinAsPlayer), and when a disconnected player's grace period
      // expires and they're detached/removed (disconnect handler in
      // bot-server.js). Both of those only ever touch `teams`, so we merge
      // just that array in rather than ignoring the message outright —
      // additions, membership changes, AND removals, all three, otherwise
      // the host's screen drifts from what every other client sees the
      // moment someone leaves.
      if (isHostRef.current) {
        const incomingTeams = data?.teams;
        if (!Array.isArray(incomingTeams)) return;

        const localTeams = s.data.teams || [];
        const incomingIds = new Set(incomingTeams.map((t) => t.id));
        const localIds = new Set(localTeams.map((t) => t.id));

        // Expire old tombstones/recent-add markers before using them.
        const now = Date.now();
        for (const [name, ts] of deletedTeamNames.current) {
          if (now - ts > TOMBSTONE_MS) deletedTeamNames.current.delete(name);
        }
        for (const [id, ts] of recentlyAddedTeamIds.current) {
          if (now - ts > RECENT_ADD_MS) recentlyAddedTeamIds.current.delete(id);
        }

        // New teams the server knows about that we don't yet (a player
        // just auto-created one via joinAsPlayer) — add them, unless we
        // deliberately just deleted a team with that same name.
        const newTeams = incomingTeams.filter((t) => {
          if (localIds.has(t.id)) return false;
          if (t.name && deletedTeamNames.current.has(t.name.trim().toLowerCase())) return false;
          return true;
        });

        // Teams the server no longer has at all — either its disconnect
        // grace-period cleanup dropped them, or someone else's edit did.
        // Adopt that removal locally too, unless it's a team we just
        // added ourselves and the server echo simply hasn't caught up yet.
        const removedIds = new Set(
          localTeams
            .filter((t) => !incomingIds.has(t.id) && !recentlyAddedTeamIds.current.has(t.id))
            .map((t) => t.id)
        );

        let changed = newTeams.length > 0 || removedIds.size > 0;

        // For teams both sides still agree exist, sync discordUserIds
        // fully (both growing AND shrinking) — the server is the sole
        // source of truth for who's actually connected to a team, since
        // only joinAsPlayer/disconnect ever mutate this from its side.
        const mergedExisting = localTeams
          .filter((t) => !removedIds.has(t.id))
          .map((t) => {
            const remote = incomingTeams.find((rt) => rt.id === t.id);
            if (!remote || !Array.isArray(remote.discordUserIds)) return t;
            const currentIds = t.discordUserIds || [];
            const remoteIds = remote.discordUserIds;
            const same =
              currentIds.length === remoteIds.length && currentIds.every((id) => remoteIds.includes(id));
            if (!same) changed = true;
            return same ? t : { ...t, discordUserIds: remoteIds };
          });

        if (!changed) return; // just our own echo, ignore

        s.data.teams = [...mergedExisting, ...newTeams];
        persist();
        return;
      }

      // Last-write-wins: ignore a remote update older than what we already have.
      if (updatedAt && s.updatedAt && updatedAt < s.updatedAt) return;
      setSession((prev) => (prev ? { ...prev, data, updatedAt } : prev));
    };

    socket.on("connect", handleConnect);
    socket.on("playersUpdate", handlePlayersUpdate);
    socket.on("boardUpdate", handleBoardUpdate);

    // Socket may already be connected (shared across hooks that mount at
    // slightly different times) — join immediately rather than waiting
    // for a 'connect' event that already fired.
    if (socket.connected) handleConnect();

    return () => {
      socket.off("connect", handleConnect);
      socket.off("playersUpdate", handlePlayersUpdate);
      socket.off("boardUpdate", handleBoardUpdate);
    };
  }, [socket]);

  const setRoomCode = useCallback((code) => {
    roomCodeRef.current = code || null;
    if (code && socketRef.current?.connected) {
      socketRef.current.emit("joinRoom", { roomCode: code, role: "host" });
      const s = sessionRef.current;
      if (s && isHostRef.current) {
        socketRef.current.emit("boardUpdate", {
          roomCode: code,
          data: s.data,
          updatedAt: s.updatedAt,
        });
      }
    }
  }, []);

  const rotateRoomCode = useCallback((oldCode, newCode) => {
    if (!oldCode || !newCode || !socketRef.current?.connected) {
      return Promise.reject(new Error("The host is not connected to the game server."));
    }
    return new Promise((resolve, reject) => {
      socketRef.current.emit("rotateRoomCode", { oldRoomCode: oldCode, newRoomCode: newCode }, (response) => {
        if (response?.ok) resolve();
        else reject(new Error(response?.error || "The server could not change the room code."));
      });
    });
  }, []);

  function touch() {
    setSession((s) => (s ? { ...s } : s));
  }

  const persist = useCallback(() => {
    touch();
    clearTimeout(persistTimeout.current);
    persistTimeout.current = setTimeout(async () => {
      const s = sessionRef.current;
      if (!s) return;

      let saved;
      try {
        saved = await saveSessionTolerant(s);
      } catch (err) {
        // Network was down (or the API call otherwise failed) when this
        // fired. Previously this rejection had no catch anywhere in the
        // chain — it became a silent unhandled promise rejection, and the
        // edit that triggered this persist() was just lost: never saved,
        // never broadcast, with no retry once connectivity came back.
        // Schedule one retry attempt shortly after reconnect instead of
        // dropping it. If `s` has since changed again, that later edit's
        // own persist() call will already cover this save, so re-running
        // saveSessionTolerant here is harmless (same tolerant path).
        console.warn("Autosave failed, will retry once reconnected:", err.message);
        const retry = () => {
          socketRef.current?.off("connect", retry);
          persist();
        };
        socketRef.current?.once ? socketRef.current.once("connect", retry) : socketRef.current?.on("connect", retry);
        return;
      }
      if (!saved) return; // board's gone — nothing to broadcast either

      setSaveMsg('Saved to "' + s.name + '"');
      clearTimeout(saveMsgTimeout.current);
      saveMsgTimeout.current = setTimeout(() => setSaveMsg(""), 1800);

      if (roomCodeRef.current && isHostRef.current) {
        socketRef.current?.emit("boardUpdate", {
          roomCode: roomCodeRef.current,
          data: s.data,
          updatedAt: s.updatedAt,
        });
      }
    }, 400);
  }, []);

  const flushPersist = useCallback(async () => {
    if (persistTimeout.current) {
      clearTimeout(persistTimeout.current);
      persistTimeout.current = null;
    }
    const s = sessionRef.current;
    if (s) await saveSessionTolerant(s);
  }, []);

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (persistTimeout.current) {
        const s = sessionRef.current;
        if (s) SessionStore.saveSession(s).catch(() => {});
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  return {
    session,
    setSession,
    sessionRef,
    touch,
    persist,
    flushPersist,
    saveMsg,
    setRoomCode,
    rotateRoomCode,
    markTeamDeleted,
    markTeamAdded,
    players,
  };
}