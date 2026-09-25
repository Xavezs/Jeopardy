// lib/hooks/useFinalSync.js
import { useEffect, useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";

/* =========================================================================
   useFinalSync
   Player -> host relay for Final Jeopardy wagers AND answers. Unlike
   useWagerSync (1 wager, from whoever currently holds board control), this
   has no "turn" concept at all — every player may submit a wager/answer
   any time during the corresponding phase, and the server
   (submitFinalWager / submitFinalAnswer) only checks that they're a
   registered player, not who's "next".

   Shares the tab's single socket via SocketContext (see SocketContext.jsx)
   instead of opening its own connection.

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
  const { socket } = useSocket();
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  const onWagerRef = useRef(onFinalWagerSubmitted);
  onWagerRef.current = onFinalWagerSubmitted;
  const onAnswerRef = useRef(onFinalAnswerSubmitted);
  onAnswerRef.current = onFinalAnswerSubmitted;

  const meRef = useRef(me);
  meRef.current = me;

  useEffect(() => {
    if (!socket) return;

    const handleConnect = () => {
      if (roomCodeRef.current) socket.emit("joinRoom", roomCodeRef.current);
    };
    const handleFinalWager = (payload) => onWagerRef.current?.(payload);
    const handleFinalAnswer = (payload) => onAnswerRef.current?.(payload);

    socket.on("connect", handleConnect);
    socket.on("finalWagerSubmitted", handleFinalWager);
    socket.on("finalAnswerSubmitted", handleFinalAnswer);

    if (socket.connected && roomCodeRef.current) {
      socket.emit("joinRoom", roomCodeRef.current);
    }

    return () => {
      socket.off("connect", handleConnect);
      socket.off("finalWagerSubmitted", handleFinalWager);
      socket.off("finalAnswerSubmitted", handleFinalAnswer);
    };
  }, [socket]);

  useEffect(() => {
    if (roomCode && socket?.connected) {
      socket.emit("joinRoom", roomCode);
    }
  }, [roomCode, socket]);

  const submitFinalWager = useCallback((amount) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socket) return;
    socket.emit("submitFinalWager", {
      roomCode,
      amount,
      discordUserId: meRef.current?.discordUserId ?? null,
    });
  }, [socket]);

  const submitFinalAnswer = useCallback((answer) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socket) return;
    socket.emit("submitFinalAnswer", {
      roomCode,
      answer,
      discordUserId: meRef.current?.discordUserId ?? null,
    });
  }, [socket]);

  return { submitFinalWager, submitFinalAnswer };
}