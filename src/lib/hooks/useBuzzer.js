// lib/hooks/useBuzzer.js
import { useEffect, useState, useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";
import { playBuzzSfx } from "../boardSfx";

/* =========================================================================
   useBuzzer
   Listens on bot-server.js's buzzer channel, scoped to one `roomCode`
   (the same code players use to join the board). Two things can feed the
   buzzer: Discord's /buzz slash command (from a linked voice channel) and
   this hook's own `buzz()` — the in-browser Buzz button. Both land in the
   same queue since the server keys everything by roomCode.

   Shares the tab's single socket via SocketContext (see SocketContext.jsx)
   instead of opening its own connection — listeners are added/removed
   with socket.on/off, and `connected` now reflects the shared socket's
   state rather than a connection this hook owned itself.

   `roomCode` — required to receive/send anything. Pass null while it's
   still loading and this hook just sits idle.
   `me` — { id, username, avatarUrl } for the current logged-in player,
   needed to call `buzz()` from the web. Not needed just to spectate.

   `armBuzzer()` opens the buzzer for a fresh round and clears the queue.
   `resetBuzzer()` closes it again and clears the queue.
   `nextBuzzer()` advances to whoever buzzed in next without losing the
   rest of the queue or reopening the buzzer to everyone.
   `prevBuzzer()` steps back to whoever had the floor before, for
   correcting an accidental advance. Clamped at -1 (no one active) — it
   won't wrap past the start of the queue.
   `buzz()` — the web player's own buzz-in action.

   `queue` is the ordered list of everyone who's buzzed this round.
   `activePlayer` is whoever currently has the floor to answer (or null).
   ========================================================================= */
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

      // Only a real buzz-in ever appends to the queue — armBuzzer/
      // resetBuzzer clear it, nextBuzzer/prevBuzzer just move the pointer
      // across entries that are already there. Gating on queue length
      // (instead of "did the active id change") means manually stepping
      // through people who already buzzed never replays the sound.
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

  // Re-join if the room code shows up after connect, or changes (e.g.
  // switching which board/session is active).
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

  // The web Buzz button. No-ops if there's no room code or no logged-in player.
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