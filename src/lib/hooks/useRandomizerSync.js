import { useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";

export function useRandomizerSync(roomCode) {
  const { socket } = useSocket();

  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  const publishRandomizer = useCallback((randomizer) => {
    const code = roomCodeRef.current;

    if (!code || !socket) return;

    const payload = { roomCode: code, randomizer };

    if (socket.connected) {
      socket.emit("randomizerUpdate", payload);
    } else {
      socket.once("connect", () => {
        socket.emit("randomizerUpdate", payload);
      });
    }
  }, [socket]);

  return { publishRandomizer };
}