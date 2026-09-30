// lib/hooks/useWagerSync.js
import { useEffect, useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";

/* =========================================================================
   useWagerSync
   Player -> host relay for Daily Double wagers. Same shape as
   useControlSync's selectClue/clueSelected pair: the player emits
   submitWager, the server re-validates it's actually their turn
   (controlDiscordUserId, same check selectClue already does) and relays
   it to the room as wagerSubmitted. The host is expected to respond by
   calling its own setDailyDoubleWager(amount) — this hook never sets
   anything itself, it just relays the number.

   Shares the tab's single socket via SocketContext (see SocketContext.jsx)
   instead of opening its own connection — listeners are added/removed
   with socket.on/off rather than the socket itself being created/torn
   down here.

   `roomCode` — required to receive/send anything.
   `me` — { discordUserId } for the current logged-in player. Only needed
   PLAYER-SIDE, to stamp outgoing wagers; pass null on the host (it never
   calls submitWager itself — see ClueModal's manual fallback for that).
   `onWagerSubmitted` — HOST-SIDE ONLY. Called with { discordUserId, amount }
   whenever a player locks in their wager. The host should still re-check
   discordUserId against its own current controlDiscordUserId before
   applying it, in case control moved on between the clue opening and this
   event arriving (e.g. a very late/duplicate submit after a fallback).
   `submitWager(amount)` — PLAYER-SIDE. Sends the wager. The server drops
   it silently if it's not actually this player's turn to wager — this
   only fires the request, it doesn't self-gate, so the caller should
   still gate the UI on being the specific control holder (not
   OPEN_CONTROL) for good UX, same as selectClue/isMyTurn.
   ========================================================================= */
export function useWagerSync(roomCode, me, { onWagerSubmitted } = {}) {
  const { socket } = useSocket();
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  // Same ref-not-dependency reasoning as useControlSync's
  // onClueSelectedRef/meRef — keeps listener attachment stable across
  // re-renders while always calling the latest callback/identity.
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

    // Socket may already be connected (shared across hooks that mount at
    // slightly different times) — join immediately rather than waiting
    // for a 'connect' event that already fired.
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