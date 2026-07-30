// lib/hooks/useBuzzer.js
import { useEffect, useState, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import { playBuzzSfx } from "../boardSfx";

const BOT_SERVER_URL = import.meta.env.VITE_BOT_SERVER_URL ?? "";

/* =========================================================================
   useBuzzer
   Connects to bot-server.js's buzzer channel, scoped to one `roomCode`
   (the same code players use to join the board). Two things can feed the
   buzzer: Discord's /buzz slash command (from a linked voice channel) and
   this hook's own `buzz()` — the in-browser Buzz button. Both land in the
   same queue since the server keys everything by roomCode.

   `roomCode` — required to receive/send anything. Pass null while it's
   still loading and this hook just sits idle.
   `me` — { id, username, avatarUrl } for the current logged-in player,
   needed to call `buzz()` from the web. Not needed just to spectate.

   `armBuzzer()` opens the buzzer for a fresh round and clears the queue.
   `resetBuzzer()` closes it again and clears the queue.
   `nextBuzzer()` advances to whoever buzzed in next without losing the
   rest of the queue or reopening the buzzer to everyone.
   `buzz()` — the web player's own buzz-in action.

   `queue` is the ordered list of everyone who's buzzed this round.
   `activePlayer` is whoever currently has the floor to answer (or null).
   ========================================================================= */
export function useBuzzer(roomCode, me) {
  const [buzzerLive, setBuzzerLive] = useState(false);
  const [queue, setQueue] = useState([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);
  const prevActiveIdRef = useRef(null);
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  useEffect(() => {
    const socket = io(BOT_SERVER_URL);
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      if (roomCodeRef.current) socket.emit("joinRoom", roomCodeRef.current);
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("buzzerState", ({ live, queue: q, activeIndex: idx }) => {
      setBuzzerLive(live);
      setQueue(q || []);
      setActiveIndex(idx);

      const active = q && idx >= 0 && idx < q.length ? q[idx] : null;
      if (active && prevActiveIdRef.current !== active.id) {
        playBuzzSfx();
      }
      prevActiveIdRef.current = active ? active.id : null;
    });

    return () => socket.disconnect();
  }, []);

  // Re-join if the room code shows up after connect, or changes (e.g.
  // switching which board/session is active).
  useEffect(() => {
    if (roomCode && socketRef.current?.connected) {
      socketRef.current.emit("joinRoom", roomCode);
    }
  }, [roomCode]);

  const armBuzzer = useCallback(() => {
    if (roomCodeRef.current) socketRef.current?.emit("armBuzzer", roomCodeRef.current);
  }, []);

  const resetBuzzer = useCallback(() => {
    if (roomCodeRef.current) socketRef.current?.emit("resetBuzzer", roomCodeRef.current);
  }, []);

  const nextBuzzer = useCallback(() => {
    if (roomCodeRef.current) socketRef.current?.emit("nextBuzzer", roomCodeRef.current);
  }, []);

  // The web Buzz button. No-ops if there's no room code or no logged-in player.
  const buzz = useCallback(() => {
    if (!roomCodeRef.current || !me?.id) return;
    socketRef.current?.emit("buzz", { roomCode: roomCodeRef.current, player: me });
  }, [me]);

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
    buzz,
  };
}
