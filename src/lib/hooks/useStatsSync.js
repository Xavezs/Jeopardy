import { useEffect, useRef, useState } from "react";
import { useSocket } from "../SocketContext";

export function useStatsSync(roomCode) {
  const [playerStats, setPlayerStats] = useState({});
  const { socket } = useSocket();
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  useEffect(() => {
    if (!socket) return;

    const handleConnect = () => {
      if (roomCodeRef.current) socket.emit("joinRoom", roomCodeRef.current);
    };
    const handleStatsUpdate = (stats) => setPlayerStats(stats || {});

    socket.on("connect", handleConnect);
    socket.on("statsUpdate", handleStatsUpdate);

    if (socket.connected && roomCodeRef.current) {
      socket.emit("joinRoom", roomCodeRef.current);
    }

    return () => {
      socket.off("connect", handleConnect);
      socket.off("statsUpdate", handleStatsUpdate);
    };
  }, [socket]);

  useEffect(() => {
    if (roomCode && socket?.connected) {
      socket.emit("joinRoom", roomCode);
    }
  }, [roomCode, socket]);

  return { playerStats };
}