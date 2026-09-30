// lib/hooks/useStatsSync.js
import { useEffect, useRef, useState } from "react";
import { useSocket } from "../SocketContext";

/* =========================================================================
   useStatsSync
   Host-side listener for the per-player correct/wrong counters the server
   tracks in room.playerStats (see bot-server.js's judgeAnswer handler).
   joinRoom already resends the room's current playerStats to any socket
   that joins (host included), same as it does for buzzerState/
   activeClueUpdate/controlChanged, so this needs nothing new server-side.

   Shares the tab's single socket via SocketContext (see SocketContext.jsx)
   instead of opening its own connection.

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
  const { socket } = useSocket();
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  useEffect(() => {
    if (!socket) return;

    const handleConnect = () => {
      if (roomCodeRef.current) socket.emit("joinRoom", roomCodeRef.current);
    };
    const handleStatsUpdate = (stats) => setPlayerStats(stats || {});

    socket.on("connect", handleConnect);
    socket.on("statsUpdate", handleStatsUpdate);

    if (socket.connected && roomCodeRef.current) {
      socket.emit("joinRoom", roomCodeRef.current);
    }

    return () => {
      socket.off("connect", handleConnect);
      socket.off("statsUpdate", handleStatsUpdate);
    };
  }, [socket]);

  // Re-join if roomCode shows up/changes after the socket already connected
  // (mirrors the same pattern in usePlayerSync/useControlSync-style hooks —
  // roomCode is often not known yet on first mount).
  useEffect(() => {
    if (roomCode && socket?.connected) {
      socket.emit("joinRoom", roomCode);
    }
  }, [roomCode, socket]);

  return { playerStats };
}