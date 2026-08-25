// lib/hooks/useRandomizerSync.js
import { useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";

const BOT_SERVER_URL = import.meta.env.VITE_BOT_SERVER_URL ?? "";

/* =========================================================================
   useRandomizerSync (Host-side publish only)
   
   Mirrors the structure of useBgmSync/useRoundBannerSync. The host maintains 
   its own socket connection and emits a 'randomizerUpdate' event whenever 
   the randomizer's state changes. 
   
   The bot-server.js relays this event to all other clients in the room 
   and resends the latest state to late joiners (similar to the handling 
   of activeClue, revealedCats, and bgm). 
   
   Note: The player side reads this state via the `randomizer` field in 
   the `usePlayerSync` hook, not through this file.
   ========================================================================= */
export function useRandomizerSync(roomCode) {
  const socketRef = useRef(null);
  
  // Use a ref to keep track of the latest roomCode without triggering 
  // unnecessary re-renders or requiring it in the useCallback dependencies.
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  useEffect(() => {
    // Initialize the socket connection
    const socket = io(BOT_SERVER_URL);
    socketRef.current = socket;

    // Cleanup function: disconnect the socket when the component unmounts
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const publishRandomizer = useCallback((randomizer) => {
    const code = roomCodeRef.current;
    const socket = socketRef.current;

    // Ensure both the room code and the socket connection exist before emitting
    if (!code || !socket) return;

    const payload = { roomCode: code, randomizer };

    // socket.emit() before the initial connect DOES get buffered by
    // socket.io-client and flushed on connect — but only if this exact
    // socket instance survives long enough to actually connect. If this
    // hook's owning screen unmounts/remounts in that window (StrictMode
    // double-invoke, fast host clicks, navigating away and back), the
    // effect's cleanup disconnects the old socket before it ever flushes,
    // silently dropping the very first spin. Explicitly waiting for
    // `connected` (and re-emitting once it fires) avoids depending on that
    // buffering behavior at all.
    if (socket.connected) {
      socket.emit("randomizerUpdate", payload);
    } else {
      socket.once("connect", () => {
        // Guard against the socket having been swapped out (unmount/
        // remount) between scheduling this listener and it firing.
        if (socketRef.current === socket) socket.emit("randomizerUpdate", payload);
      });
    }
  }, []);

  return { publishRandomizer };
}