// lib/hooks/useBgmSync.js
import { useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";

/* =========================================================================
   useBgmSync (HOST SIDE)
   Publishes "here's what background music is doing right now" to the
   room — live "for the show" state, not part of the persisted board data,
   since bgmSettings is deliberately global/local rather than session data
   (see useBgmSettings.js).

   Deliberately excludes volume — each client's volume is local-only and
   never synced (see BackgroundMusicPlayer's onPlaybackChange callback,
   which is what feeds publishBgm below). What IS sent:
     { fileRef, fileName, loop, playing, positionSeconds, updatedAt }
   positionSeconds + updatedAt let a late-joining player compute the
   correct current playback position (positionSeconds, plus elapsed time
   since updatedAt if playing) without needing a live position stream.

   Shares the tab's single socket via SocketContext (see SocketContext.jsx)
   instead of opening its own connection.
   ========================================================================= */
export function useBgmSync(roomCode) {
  const { socket } = useSocket();
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  const publishBgm = useCallback((bgm) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socket) return;
    socket.emit("bgmUpdate", { roomCode, bgm });
  }, [socket]);

  return { publishBgm };
}