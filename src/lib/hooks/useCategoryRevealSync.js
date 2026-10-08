import { useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";

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