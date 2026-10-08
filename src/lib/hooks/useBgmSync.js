import { useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";

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