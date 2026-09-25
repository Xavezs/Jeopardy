// lib/hooks/useClueSync.js
import { useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";

/* =========================================================================
   useClueSync (HOST SIDE)
   Publishes "this clue is currently open" (or null when closed/completed)
   to the room, plus whether the answer has been revealed. Live "for the
   show" state, not part of the persisted board data, so it never goes
   through usePersistence's boardUpdate/autosave path.

   Players already have the actual question/answer text via their synced
   boardData (usePlayerSync) — all this needs to carry is which cell is
   open, so PlayerView can look the clue up locally.

   Shares the tab's single socket via SocketContext (see SocketContext.jsx)
   instead of opening its own connection.
   ========================================================================= */
export function useClueSync(roomCode) {
  const { socket } = useSocket();
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  const publishActiveClue = useCallback((activeClue) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socket) return;
    socket.emit("activeClueUpdate", { roomCode, activeClue });
  }, [socket]);

  return { publishActiveClue };
}