// lib/hooks/useDiscordMembers.js
import { useEffect, useState, useRef } from "react";
import { io } from "socket.io-client";

const BOT_SERVER_URL = "http://localhost:4001";

// One shared socket for the whole app — every team-card speaking/mute
// indicator reads from this same connection instead of each opening
// its own.
export function useDiscordMembers() {
  const [members, setMembers] = useState([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);

  useEffect(() => {
    const socket = io(BOT_SERVER_URL);
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("voiceState", (data) => setMembers(data));

    return () => socket.disconnect();
  }, []);

  return { members, connected };
}