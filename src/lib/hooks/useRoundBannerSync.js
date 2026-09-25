// lib/hooks/useRoundBannerSync.js
import { useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";

/* =========================================================================
   useRoundBannerSync (HOST SIDE)
   Publishes the "DOUBLE JEOPARDY!"-style round-switch banner to the room.
   Live "for the show" state (see useBoardGrid.js's roundBanner —
   explicitly never persisted), not part of the boardUpdate/autosave path.

   Players don't need anything else to render it — the banner is just
   { text, phase: "in" | "out" } and PlayerView renders the identical
   .round-banner markup the host does, driven purely by this value.

   Shares the tab's single socket via SocketContext (see SocketContext.jsx)
   instead of opening its own connection.
   ========================================================================= */
export function useRoundBannerSync(roomCode) {
  const { socket } = useSocket();
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  const publishRoundBanner = useCallback((roundBanner) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socket) return;
    socket.emit("roundBannerUpdate", { roomCode, roundBanner: roundBanner || null });
  }, [socket]);

  return { publishRoundBanner };
}