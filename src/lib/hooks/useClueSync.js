import { useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";

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