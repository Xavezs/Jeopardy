import { useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";

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