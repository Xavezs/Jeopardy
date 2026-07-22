// lib/hooks/useBuzzer.js
import { useEffect, useState, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import { playBuzzSfx } from "../boardSfx";

const BOT_SERVER_URL = "http://localhost:4001";

/* =========================================================================
   useBuzzer
   Own connection to bot-server.js's buzzer channel (separate socket from
   useDiscordMembers — different concern, and this one needs to both listen
   AND emit host commands, so there's no benefit to sharing).

   `armBuzzer()` opens the window for the FIRST /buzz in Discord to win.
   `resetBuzzer()` closes it again without a winner (e.g. wrong answer,
   moving to the next clue). `winner` is null until someone buzzes, then
   holds { id, username, avatarUrl, timestamp } until the next arm/reset.
   ========================================================================= */
export function useBuzzer() {
  const [buzzerLive, setBuzzerLive] = useState(false);
  const [winner, setWinner] = useState(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);
  const prevWinnerRef = useRef(null);

  useEffect(() => {
    const socket = io(BOT_SERVER_URL);
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("buzzerState", ({ live, winner: w }) => {
      setBuzzerLive(live);
      
      // 🔊 Play buzzer sound when a new winner buzzes in
      if (w && (!prevWinnerRef.current || prevWinnerRef.current.id !== w.id)) {
        playBuzzSfx();
      }
      
      prevWinnerRef.current = w;
      setWinner(w);
    });

    return () => socket.disconnect();
  }, []);

  const armBuzzer = useCallback(() => {
    socketRef.current?.emit("armBuzzer");
  }, []);

  const resetBuzzer = useCallback(() => {
    socketRef.current?.emit("resetBuzzer");
  }, []);

  return { buzzerLive, winner, connected, armBuzzer, resetBuzzer };
}