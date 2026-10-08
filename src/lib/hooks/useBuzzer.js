import { useEffect, useState, useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";
import { playBuzzSfx } from "../boardSfx";

export function useBuzzer(roomCode, me) {
  const [buzzerLive, setBuzzerLive] = useState(false);
  const [queue, setQueue] = useState([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const { socket, connected } = useSocket();
  const prevQueueLenRef = useRef(0);
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  useEffect(() => {
    if (!socket) return;

    const handleConnect = () => {
      if (roomCodeRef.current) socket.emit("joinRoom", roomCodeRef.current);
    };
    const handleBuzzerState = ({ live, queue: q, activeIndex: idx }) => {
      setBuzzerLive(live);
      setQueue(q || []);
      setActiveIndex(idx);

      const len = q ? q.length : 0;
      if (len > prevQueueLenRef.current) playBuzzSfx();
      prevQueueLenRef.current = len;
    };

    socket.on("connect", handleConnect);
    socket.on("buzzerState", handleBuzzerState);

    if (socket.connected && roomCodeRef.current) {
      socket.emit("joinRoom", roomCodeRef.current);
    }

    return () => {
      socket.off("connect", handleConnect);
      socket.off("buzzerState", handleBuzzerState);
    };
  }, [socket]);

  useEffect(() => {
    if (roomCode && socket?.connected) {
      socket.emit("joinRoom", roomCode);
    }
  }, [roomCode, socket]);

  const armBuzzer = useCallback(() => {
    if (roomCodeRef.current && socket) socket.emit("armBuzzer", roomCodeRef.current);
  }, [socket]);

  const resetBuzzer = useCallback(() => {
    if (roomCodeRef.current && socket) socket.emit("resetBuzzer", roomCodeRef.current);
  }, [socket]);

  const nextBuzzer = useCallback(() => {
    if (roomCodeRef.current && socket) socket.emit("nextBuzzer", roomCodeRef.current);
  }, [socket]);

  const prevBuzzer = useCallback(() => {
    if (roomCodeRef.current && socket) socket.emit("prevBuzzer", roomCodeRef.current);
  }, [socket]);

  // The web Buzz button
  const buzz = useCallback(() => {
    if (!roomCodeRef.current || !me?.id || !socket) return;
    socket.emit("buzz", { roomCode: roomCodeRef.current, player: me });
  }, [me, socket]);

  const activePlayer = activeIndex >= 0 && activeIndex < queue.length ? queue[activeIndex] : null;
  const alreadyBuzzed = !!me?.id && queue.some((p) => p.id === me.id);

  return {
    buzzerLive,
    queue,
    activeIndex,
    activePlayer,
    winner: activePlayer, // back-compat alias
    connected,
    alreadyBuzzed,
    armBuzzer,
    resetBuzzer,
    nextBuzzer,
    prevBuzzer,
    buzz,
  };
}