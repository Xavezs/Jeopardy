import { useEffect, useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";

export function useFinalSync(roomCode, me, { onFinalWagerSubmitted, onFinalAnswerSubmitted } = {}) {
  const { socket } = useSocket();
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  const onWagerRef = useRef(onFinalWagerSubmitted);
  onWagerRef.current = onFinalWagerSubmitted;
  const onAnswerRef = useRef(onFinalAnswerSubmitted);
  onAnswerRef.current = onFinalAnswerSubmitted;

  const meRef = useRef(me);
  meRef.current = me;

  useEffect(() => {
    if (!socket) return;

    const handleConnect = () => {
      if (roomCodeRef.current) socket.emit("joinRoom", roomCodeRef.current);
    };
    const handleFinalWager = (payload) => onWagerRef.current?.(payload);
    const handleFinalAnswer = (payload) => onAnswerRef.current?.(payload);

    socket.on("connect", handleConnect);
    socket.on("finalWagerSubmitted", handleFinalWager);
    socket.on("finalAnswerSubmitted", handleFinalAnswer);

    if (socket.connected && roomCodeRef.current) {
      socket.emit("joinRoom", roomCodeRef.current);
    }

    return () => {
      socket.off("connect", handleConnect);
      socket.off("finalWagerSubmitted", handleFinalWager);
      socket.off("finalAnswerSubmitted", handleFinalAnswer);
    };
  }, [socket]);

  useEffect(() => {
    if (roomCode && socket?.connected) {
      socket.emit("joinRoom", roomCode);
    }
  }, [roomCode, socket]);

  const submitFinalWager = useCallback((amount) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socket) return;
    socket.emit("submitFinalWager", {
      roomCode,
      amount,
      discordUserId: meRef.current?.discordUserId ?? null,
    });
  }, [socket]);

  const submitFinalAnswer = useCallback((answer) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socket) return;
    socket.emit("submitFinalAnswer", {
      roomCode,
      answer,
      discordUserId: meRef.current?.discordUserId ?? null,
    });
  }, [socket]);

  return { submitFinalWager, submitFinalAnswer };
}