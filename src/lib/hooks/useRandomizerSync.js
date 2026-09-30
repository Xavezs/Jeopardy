// lib/hooks/useRandomizerSync.js
import { useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";

/* =========================================================================
   useRandomizerSync (Host-side publish only)

   Mirrors the structure of useBgmSync/useRoundBannerSync. Emits a
   'randomizerUpdate' event whenever the randomizer's state changes.

   The bot-server.js relays this event to all other clients in the room
   and resends the latest state to late joiners (similar to the handling
   of activeClue, revealedCats, and bgm).

   Note: The player side reads this state via the `randomizer` field in
   the `usePlayerSync` hook, not through this file.

   Shares the tab's single socket via SocketContext (see SocketContext.jsx).
   The socket is now owned by the provider and stays connected across this
   hook's own mounts/unmounts, so the old "unmount disconnects the socket
   before the buffered first emit flushes" race this hook used to guard
   against can no longer happen from THIS hook's side. The connected-check
   + once("connect") fallback below is kept anyway as cheap insurance for
   the brief window right after the provider's socket is first created,
   before its initial connect has completed.
   ========================================================================= */
export function useRandomizerSync(roomCode) {
  const { socket } = useSocket();

  // Use a ref to keep track of the latest roomCode without triggering
  // unnecessary re-renders or requiring it in the useCallback dependencies.
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  const publishRandomizer = useCallback((randomizer) => {
    const code = roomCodeRef.current;

    // Ensure both the room code and the shared socket exist before emitting
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