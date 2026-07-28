// lib/hooks/useBoardFlipSync.js
import { useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";

const BOT_SERVER_URL = import.meta.env.VITE_BOT_SERVER_URL ?? "";

/* =========================================================================
   useBoardFlipSync (HOST SIDE)
   Publishes the board's flip-transition phase ("idle" | "out" | "in-start"
   | "in" — see useBoardGrid.js's boardFlip) to the room, same pattern as
   useRoundBannerSync/useCategoryRevealSync: its own tiny socket + its own
   event, since this is purely a live "for the show" animation cue, never
   persisted.

   PlayerView applies the identical flip-out/flip-in-start CSS classes
   (see board.css's .pv-cat rules) to its own category columns, driven by
   this value, so the disappear/reappear ripple plays in lockstep with the
   host's board instead of the player's board just silently swapping data.
   ========================================================================= */
export function useBoardFlipSync(roomCode) {
  const socketRef = useRef(null);
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  useEffect(() => {
    const socket = io(BOT_SERVER_URL);
    socketRef.current = socket;
    return () => socket.disconnect();
  }, []);

  const publishBoardFlip = useCallback((boardFlip) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socketRef.current) return;
    socketRef.current.emit("boardFlipUpdate", { roomCode, boardFlip: boardFlip || "idle" });
  }, []);

  return { publishBoardFlip };
}
