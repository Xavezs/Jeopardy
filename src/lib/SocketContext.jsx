// lib/SocketContext.jsx
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const BOT_SERVER_URL = import.meta.env.VITE_BOT_SERVER_URL ?? "";

/* =========================================================================
   SocketProvider
   Every sync hook (useBuzzer, useControlSync, useWagerSync, useClueSync,
   useFinalSync, useCategoryRevealSync, useRoundBannerSync, useBgmSync,
   useRandomizerSync, useStatsSync, usePersistence, usePlayerSync,
   useDiscordMembers) used to open its own `io(BOT_SERVER_URL)` — up to 11
   separate sockets from a single host tab, 5 from a single player tab.

   That meant a brief network blip (tunnel hiccup, Wi-Fi drop) triggered
   that many independent reconnect races, each landing at a slightly
   different moment — e.g. the buzzer socket back online before the
   control socket, so the UI could briefly show "you can buzz" and "not
   your turn" at once. It also multiplied server-side connection count by
   ~10x for no benefit, since every socket in a room already receives
   every room-scoped event regardless of which hook opened it.

   This provider opens exactly ONE socket per browser tab (App.jsx wraps
   its whole render tree with it, above both the host and player
   branches, since a tab is always exactly one or the other). Every hook
   below now pulls that same socket via useSocket() instead of creating
   its own. Event names/payloads and each hook's public API are
   unchanged — this only changes how many transports carry them.
   ========================================================================= */
const SocketContext = createContext({ socket: null, connected: false });

export function SocketProvider({ children }) {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);

  useEffect(() => {
    const s = io(BOT_SERVER_URL);
    socketRef.current = s;
    setSocket(s);

    const handleConnect = () => setConnected(true);
    const handleDisconnect = () => setConnected(false);
    s.on("connect", handleConnect);
    s.on("disconnect", handleDisconnect);

    return () => {
      s.off("connect", handleConnect);
      s.off("disconnect", handleDisconnect);
      s.disconnect();
      socketRef.current = null;
    };
  }, []);

  return (
    <SocketContext.Provider value={{ socket, connected }}>
      {children}
    </SocketContext.Provider>
  );
}

// Returns { socket, connected }. `socket` is null for the brief window
// before the provider's effect has run (first render) — hooks that use
// this should guard effects on `if (!socket) return;`, same as they used
// to implicitly guard on socketRef.current being set.
export function useSocket() {
  return useContext(SocketContext);
}
