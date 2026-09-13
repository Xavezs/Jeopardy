// lib/hooks/useFinalSync.js
import { useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";

const BOT_SERVER_URL = import.meta.env.VITE_BOT_SERVER_URL ?? "";

/* =========================================================================
   useFinalSync
   Player -> host relay for Final Jeopardy wagers AND answers. Unlike
   useWagerSync (1 wager, from whoever currently holds board control), this
   has no "turn" concept at all — every player may submit a wager/answer
   any time during the corresponding phase, and the server
   (submitFinalWager / submitFinalAnswer) only checks that they're a
   registered player, not who's "next".

   `roomCode` — required to receive/send anything.
   `me` — { discordUserId } for the current logged-in player. Only needed
   PLAYER-SIDE, to stamp outgoing submissions; pass null on the host (it
   never calls submitFinalWager/submitFinalAnswer itself).
   `onFinalWagerSubmitted({ discordUserId, amount })` / 
   `onFinalAnswerSubmitted({ discordUserId, answer })` — HOST-SIDE ONLY.
   The host resolves discordUserId -> team via teams.resolveTeamForDiscordUser,
   clamps the wager against that team's current score, and writes it via
   final.setWager/setAnswer — this hook only relays the raw event, exactly
   like useWagerSync does for Daily Double.
   ========================================================================= */
export function useFinalSync(roomCode, me, { onFinalWagerSubmitted, onFinalAnswerSubmitted } = {}) {
  const socketRef = useRef(null);
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  const onWagerRef = useRef(onFinalWagerSubmitted);
  onWagerRef.current = onFinalWagerSubmitted;
  const onAnswerRef = useRef(onFinalAnswerSubmitted);
  onAnswerRef.current = onFinalAnswerSubmitted;

  const meRef = useRef(me);
  meRef.current = me;

  useEffect(() => {
    const socket = io(BOT_SERVER_URL);
    socketRef.current = socket;

    socket.on("connect", () => {
      if (roomCodeRef.current) socket.emit("joinRoom", roomCodeRef.current);
    });
    socket.on("finalWagerSubmitted", (payload) => onWagerRef.current?.(payload));
    socket.on("finalAnswerSubmitted", (payload) => onAnswerRef.current?.(payload));

    return () => socket.disconnect();
  }, []);

  useEffect(() => {
    if (roomCode && socketRef.current?.connected) {
      socketRef.current.emit("joinRoom", roomCode);
    }
  }, [roomCode]);

  const submitFinalWager = useCallback((amount) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode) return;
    socketRef.current?.emit("submitFinalWager", {
      roomCode,
      amount,
      discordUserId: meRef.current?.discordUserId ?? null,
    });
  }, []);

  const submitFinalAnswer = useCallback((answer) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode) return;
    socketRef.current?.emit("submitFinalAnswer", {
      roomCode,
      answer,
      discordUserId: meRef.current?.discordUserId ?? null,
    });
  }, []);

  return { submitFinalWager, submitFinalAnswer };
}
