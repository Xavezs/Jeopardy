import { useState, useRef, useEffect, useCallback } from "react";
import { useSocket } from "../SocketContext";
import { SessionStore } from "../storage";
import { emitHostJoin } from "../hostJoin";

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

  const { socket } = useSocket();
  const socketRef = useRef(null);
  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);
  const roomCodeRef = useRef(null);

  // Recently-deleted team names (lowercased) -> deletion timestamp
  const deletedTeamNames = useRef(new Map());
  const TOMBSTONE_MS = 15000;
  const markTeamDeleted = useCallback((name) => {
    if (!name) return;
    deletedTeamNames.current.set(name.trim().toLowerCase(), Date.now());
  }, []);

  const recentlyAddedTeamIds = useRef(new Map());
  const RECENT_ADD_MS = 5000;
  const markTeamAdded = useCallback((id) => {
    if (!id) return;
    recentlyAddedTeamIds.current.set(id, Date.now());
  }, []);

  const [players, setPlayers] = useState([]);

  useEffect(() => {
    if (!socket) return;

    const handleConnect = async () => {
      const roomCode = roomCodeRef.current;
      if (!roomCode) return;
      // Verified host join (ticket fetched over HTTP)
      await emitHostJoin(socket, roomCode);
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

    const handleBoardUpdate = ({ data, updatedAt }) => {
      const s = sessionRef.current;
      if (!s) return;

      if (isHostRef.current) {
        const incomingTeams = data?.teams;
        if (!Array.isArray(incomingTeams)) return;

        const localTeams = s.data.teams || [];
        const incomingIds = new Set(incomingTeams.map((t) => t.id));
        const localIds = new Set(localTeams.map((t) => t.id));

        // Expire old tombstones/recent-add markers before using them
        const now = Date.now();
        for (const [name, ts] of deletedTeamNames.current) {
          if (now - ts > TOMBSTONE_MS) deletedTeamNames.current.delete(name);
        }
        for (const [id, ts] of recentlyAddedTeamIds.current) {
          if (now - ts > RECENT_ADD_MS) recentlyAddedTeamIds.current.delete(id);
        }

        const newTeams = incomingTeams.filter((t) => {
          if (localIds.has(t.id)) return false;
          if (t.name && deletedTeamNames.current.has(t.name.trim().toLowerCase())) return false;
          return true;
        });

        const removedIds = new Set(
          localTeams
            .filter((t) => !incomingIds.has(t.id) && !recentlyAddedTeamIds.current.has(t.id))
            .map((t) => t.id)
        );

        let changed = newTeams.length > 0 || removedIds.size > 0;

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

      if (updatedAt && s.updatedAt && updatedAt < s.updatedAt) return;
      setSession((prev) => (prev ? { ...prev, data, updatedAt } : prev));
    };

    socket.on("connect", handleConnect);
    socket.on("playersUpdate", handlePlayersUpdate);
    socket.on("boardUpdate", handleBoardUpdate);

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
      const activeSocket = socketRef.current;
      emitHostJoin(activeSocket, code).then(() => {
        const s = sessionRef.current;
        if (s && isHostRef.current) {
          activeSocket.emit("boardUpdate", {
            roomCode: code,
            data: s.data,
            updatedAt: s.updatedAt,
          });
        }
      });
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
        console.warn("Autosave failed, will retry once reconnected:", err.message);
        const retry = () => {
          socketRef.current?.off("connect", retry);
          persist();
        };
        socketRef.current?.once ? socketRef.current.once("connect", retry) : socketRef.current?.on("connect", retry);
        return;
      }
      if (!saved) return;

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