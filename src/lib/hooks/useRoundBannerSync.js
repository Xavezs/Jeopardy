// lib/hooks/useRoundBannerSync.js
import { useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";

const BOT_SERVER_URL = import.meta.env.VITE_BOT_SERVER_URL ?? "";

/* =========================================================================
   useRoundBannerSync (HOST SIDE)
   Publishes the "DOUBLE JEOPARDY!"-style round-switch banner to the room,
   same pattern as useCategoryRevealSync/useClueSync: its own tiny socket +
   its own event, since this is live "for the show" state (see
   useBoardGrid.js's roundBanner — explicitly never persisted), not part
   of the boardUpdate/autosave path.

   Players don't need anything else to render it — the banner is just
   { text, phase: "in" | "out" } and PlayerView renders the identical
   .round-banner markup the host does, driven purely by this value.
   ========================================================================= */
export function useRoundBannerSync(roomCode) {
  const socketRef = useRef(null);
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  useEffect(() => {
    const socket = io(BOT_SERVER_URL);
    socketRef.current = socket;
    return () => socket.disconnect();
  }, []);

  const publishRoundBanner = useCallback((roundBanner) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socketRef.current) return;
    socketRef.current.emit("roundBannerUpdate", { roomCode, roundBanner: roundBanner || null });
  }, []);

  return { publishRoundBanner };
}
