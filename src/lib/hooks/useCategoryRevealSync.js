// lib/hooks/useCategoryRevealSync.js
import { useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";

const BOT_SERVER_URL = import.meta.env.VITE_BOT_SERVER_URL ?? "";

/* =========================================================================
   useCategoryRevealSync (HOST SIDE)
   Publishes "these category ids have been reveal-clicked" to the room.
   Same pattern as useClueSync: its own tiny socket + its own event, since
   this is live "for the show" state (see useBoardGrid.js's revealedCats —
   explicitly never persisted), not part of the boardUpdate/autosave path.

   Players receive category NAMES already via their synced boardData
   (usePlayerSync) — all this needs to carry is which ids are revealed, so
   PlayerView can gate the name display locally, same as the host does.
   ========================================================================= */
export function useCategoryRevealSync(roomCode) {
  const socketRef = useRef(null);
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  useEffect(() => {
    const socket = io(BOT_SERVER_URL);
    socketRef.current = socket;
    return () => socket.disconnect();
  }, []);

  const publishRevealedCats = useCallback((revealedCatIds) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socketRef.current) return;
    socketRef.current.emit("revealedCatsUpdate", { roomCode, revealedCats: revealedCatIds });
  }, []);

  return { publishRevealedCats };
}
