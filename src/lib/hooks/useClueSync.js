// lib/hooks/useClueSync.js
import { useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";

const BOT_SERVER_URL = import.meta.env.VITE_BOT_SERVER_URL ?? "";

/* =========================================================================
   useClueSync (HOST SIDE)
   Publishes "this clue is currently open" (or null when closed/completed)
   to the room, plus whether the answer has been revealed. Deliberately its
   own tiny socket + its own event, same pattern as useBuzzer — this is
   live "for the show" state, not part of the persisted board data, so it
   never goes through usePersistence's boardUpdate/autosave path.

   Players already have the actual question/answer text via their synced
   boardData (usePlayerSync) — all this needs to carry is which cell is
   open, so PlayerView can look the clue up locally.
   ========================================================================= */
export function useClueSync(roomCode) {
  const socketRef = useRef(null);
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  useEffect(() => {
    const socket = io(BOT_SERVER_URL);
    socketRef.current = socket;
    return () => socket.disconnect();
  }, []);

  const publishActiveClue = useCallback((activeClue) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socketRef.current) return;
    socketRef.current.emit("activeClueUpdate", { roomCode, activeClue });
  }, []);

  return { publishActiveClue };
}
