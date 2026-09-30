// src/lib/hooks/useDiscordMembers.js
import { useEffect, useState, useRef } from "react";
import { useSocket } from "../SocketContext";

export function useDiscordMembers(channelId = null) {
  const [members, setMembers] = useState([]);
  const { socket, connected } = useSocket();
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;

  useEffect(() => {
    if (!socket) return;

    const handleConnect = () => {
      if (channelIdRef.current) socket.emit("watchVoiceChannel", channelIdRef.current);
    };
    const handleVoiceState = (data) => setMembers(data);

    socket.on("connect", handleConnect);
    socket.on("voiceState", handleVoiceState);

    if (socket.connected && channelId) {
      socket.emit("watchVoiceChannel", channelId);
    }

    return () => {
      socket.off("connect", handleConnect);
      socket.off("voiceState", handleVoiceState);
    };
  }, [socket, channelId]);

  return { members, connected };
}