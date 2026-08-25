// lib/hooks/useStatsSync.js
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const BOT_SERVER_URL = import.meta.env.VITE_BOT_SERVER_URL ?? "";

/* =========================================================================
   useStatsSync
   Host-side listener for the per-player correct/wrong counters the server
   tracks in room.playerStats (see bot-server.js's judgeAnswer handler).
   Own small socket + `joinRoom` rather than piggybacking on useControlSync's
   connection — joinRoom already resends the room's current playerStats to
   any socket that joins (host included), same as it does for buzzerState/
   activeClueUpdate/controlChanged, so this needs nothing new server-side.

   Returns { playerStats } shaped like:
     { [discordUserId]: { correct: number, wrong: number } }
   Note: no username/teamId here — resolve those against `players`/`teams`
   (same as everywhere else in the app) when assembling a finalScores
   payload for SessionStore.saveGameResult, since the server-side stats
   blob deliberately doesn't duplicate identity data it already gets from
   room.players.
   ========================================================================= */
export function useStatsSync(roomCode) {
  const [playerStats, setPlayerStats] = useState({});
  const socketRef = useRef(null);
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  useEffect(() => {
    const socket = io(BOT_SERVER_URL);
    socketRef.current = socket;

    socket.on("connect", () => {
      if (roomCodeRef.current) socket.emit("joinRoom", roomCodeRef.current);
    });
    socket.on("statsUpdate", (stats) => setPlayerStats(stats || {}));

    return () => socket.disconnect();
  }, []);

  // Re-join if roomCode shows up/changes after the socket already connected
  // (mirrors the same pattern in usePlayerSync/useControlSync-style hooks —
  // roomCode is often not known yet on first mount).
  useEffect(() => {
    if (roomCode && socketRef.current?.connected) {
      socketRef.current.emit("joinRoom", roomCode);
    }
  }, [roomCode]);

  return { playerStats };
}
