// lib/hooks/useBgmSync.js
import { useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";

const BOT_SERVER_URL = import.meta.env.VITE_BOT_SERVER_URL ?? "";

/* =========================================================================
   useBgmSync (HOST SIDE)
   Publishes "here's what background music is doing right now" to the
   room — same treatment as useClueSync/useCategoryRevealSync: live "for
   the show" state with its own tiny socket, not part of the persisted
   board data, since bgmSettings is deliberately global/local rather than
   session data (see useBgmSettings.js).

   Deliberately excludes volume — each client's volume is local-only and
   never synced (see BackgroundMusicPlayer's onPlaybackChange callback,
   which is what feeds publishBgm below). What IS sent:
     { fileRef, fileName, loop, playing, positionSeconds, updatedAt }
   positionSeconds + updatedAt let a late-joining player compute the
   correct current playback position (positionSeconds, plus elapsed time
   since updatedAt if playing) without needing a live position stream.
   ========================================================================= */
export function useBgmSync(roomCode) {
  const socketRef = useRef(null);
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  useEffect(() => {
    const socket = io(BOT_SERVER_URL);
    socketRef.current = socket;
    return () => socket.disconnect();
  }, []);

  const publishBgm = useCallback((bgm) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socketRef.current) return;
    socketRef.current.emit("bgmUpdate", { roomCode, bgm });
  }, []);

  return { publishBgm };
}
