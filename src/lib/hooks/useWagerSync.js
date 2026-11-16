import { useEffect, useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";

export function useWagerSync(roomCode, me, { onWagerSubmitted } = {}) {
  const { socket } = useSocket();
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  const onWagerSubmittedRef = useRef(onWagerSubmitted);
  onWagerSubmittedRef.current = onWagerSubmitted;

  const meRef = useRef(me);
  meRef.current = me;

  useEffect(() => {
    if (!socket) return;

    const handleConnect = () => {
      if (roomCodeRef.current) socket.emit("joinRoom", roomCodeRef.current);
    };
    const handleWagerSubmitted = (payload) => onWagerSubmittedRef.current?.(payload);

    socket.on("connect", handleConnect);
    socket.on("wagerSubmitted", handleWagerSubmitted);

    if (socket.connected && roomCodeRef.current) {
      socket.emit("joinRoom", roomCodeRef.current);
    }

    return () => {
      socket.off("connect", handleConnect);
      socket.off("wagerSubmitted", handleWagerSubmitted);
    };
  }, [socket]);

  useEffect(() => {
    if (roomCode && socket?.connected) {
      socket.emit("joinRoom", roomCode);
    }
  }, [roomCode, socket]);

  const submitWager = useCallback((amount) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socket) return;
    socket.emit("submitWager", {
      roomCode,
      amount,
      discordUserId: meRef.current?.discordUserId ?? null,
    });
  }, [socket]);

  return { submitWager };
}