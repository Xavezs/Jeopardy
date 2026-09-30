// lib/hooks/useCategoryRevealSync.js
import { useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";

/* =========================================================================
   useCategoryRevealSync (HOST SIDE)
   Publishes "these category ids have been reveal-clicked" to the room.
   Live "for the show" state (see useBoardGrid.js's revealedCats —
   explicitly never persisted), not part of the boardUpdate/autosave path.

   Players receive category NAMES already via their synced boardData
   (usePlayerSync) — all this needs to carry is which ids are revealed, so
   PlayerView can gate the name display locally, same as the host does.

   Shares the tab's single socket via SocketContext (see SocketContext.jsx)
   instead of opening its own connection.
   ========================================================================= */
export function useCategoryRevealSync(roomCode) {
  const { socket } = useSocket();
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  const publishRevealedCats = useCallback((revealedCatIds) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socket) return;
    socket.emit("revealedCatsUpdate", { roomCode, revealedCats: revealedCatIds });
  }, [socket]);

  return { publishRevealedCats };
}