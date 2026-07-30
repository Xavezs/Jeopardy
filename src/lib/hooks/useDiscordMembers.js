// src/lib/hooks/useDiscordMembers.js
import { useEffect, useState, useRef } from "react";
import { io } from "socket.io-client";

// Use the current origin so Discord can apply its URL mapping. During local
// development, Vite proxies /socket.io to the bot server.
const BOT_SERVER_URL = import.meta.env.VITE_BOT_SERVER_URL ?? "";

export function useDiscordMembers(channelId = null) {
  const [members, setMembers] = useState([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);

  useEffect(() => {
    const socket = io(BOT_SERVER_URL);
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      if (channelId) {
        socket.emit("watchVoiceChannel", channelId);
      }
    });

    socket.on("disconnect", () => setConnected(false));
    socket.on("voiceState", (data) => setMembers(data));

    return () => socket.disconnect();
  }, [channelId]);

  return { members, connected };
}
