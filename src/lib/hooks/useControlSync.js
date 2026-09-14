// lib/hooks/useControlSync.js
import { useEffect, useState, useRef, useCallback } from "react";
import { io } from "socket.io-client";

const BOT_SERVER_URL = import.meta.env.VITE_BOT_SERVER_URL ?? "";

/* =========================================================================
   useControlSync
   Tracks and updates who currently holds "board control" — i.e. who's
   allowed to pick the next category/clue. Keyed by discordUserId (stable
   across reconnects), never socket.id, same reasoning as usePlayerSync's
   team-identity handling — see bot-server.js's controlDiscordUserId notes.

   `roomCode` — required to receive/send anything.
   `me` — { discordUserId } for the current logged-in player. Needed to
   compute `isMyTurn`; not needed just to observe/spectate or on the host.
   `onClueSelected` — HOST-SIDE ONLY. Called with { catId, value } whenever
   a player picks a clue cell. The host is expected to respond by calling
   its own clueEditor.openClueModal(cat, value) — this hook never opens
   anything itself, it just relays the pick.

   `controlDiscordUserId` — whoever currently holds control, or null if
   nobody's been assigned yet (unrestricted pick).
   `isMyTurn` — convenience bool: true if `me` is the current control
   holder, OR the host has explicitly opened control to everyone
   (see OPEN_CONTROL below). If nobody holds control yet (null), this is
   false for everyone — the board starts locked until the host assigns
   someone via `hostSetControl` or a player earns it via a correct judged
   answer.
   `selectClue({ catId, value })` — PLAYER-SIDE. Requests to pick a clue.
   Server validates and will reject (via `errorMsg`) if it's not actually
   their turn — this only fires the request, it doesn't self-gate, so the
   caller should still gate the click on `isMyTurn` for good UX.
   `judgeAnswer(discordUserId, correct)` — HOST-SIDE. Call after judging;
   on `correct: true` the server transfers control to `discordUserId` and
   broadcasts `controlChanged`. Wrong/no-answer: don't call it at all —
   control stays with whoever already has it.
   `hostSetControl(discordUserId)` — HOST-SIDE override/fallback, e.g.
   handing control to someone else if the current holder has gone
   AFK/disconnected.
   ========================================================================= */
// Must match the OPEN_CONTROL sentinel in bot-server.js exactly — the two
// sides don't share a module, so this is duplicated by value on purpose.
// Exported so UI code (e.g. Toolbar.jsx's control-assign dropdown) can
// reference this one constant instead of hardcoding the string again.
export const OPEN_CONTROL = "__OPEN__";

export function useControlSync(roomCode, me, { onClueSelected, onLocalControlChanged } = {}) {
  const [controlDiscordUserId, setControlDiscordUserId] = useState(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  // Kept in a ref (not the effect's dependency array) so a new function
  // reference from the host re-rendering doesn't tear down and reconnect
  // the socket — only the latest callback is ever invoked.
  const onClueSelectedRef = useRef(onClueSelected);
  onClueSelectedRef.current = onClueSelected;
  const onLocalControlChangedRef = useRef(onLocalControlChanged);
  onLocalControlChangedRef.current = onLocalControlChanged;

  // Same reasoning as onClueSelectedRef: selectClue below is memoized with
  // an empty dep array, so it needs a ref (not a closed-over `me`) to see
  // the latest discordUserId without being recreated every render.
  const meRef = useRef(me);
  meRef.current = me;

  useEffect(() => {
    const socket = io(BOT_SERVER_URL);
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      if (roomCodeRef.current) socket.emit("joinRoom", roomCodeRef.current);
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("controlChanged", ({ controlDiscordUserId: id }) => {
      const nextId = id ?? null;
      setControlDiscordUserId(nextId);
    });
    socket.on("clueSelected", (payload) => {
      onClueSelectedRef.current?.(payload);
    });

    return () => socket.disconnect();
  }, []);

  useEffect(() => {
    if (roomCode && socketRef.current?.connected) {
      socketRef.current.emit("joinRoom", roomCode);
    }
  }, [roomCode]);

  const selectClue = useCallback(({ catId, value }) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode) return;
    socketRef.current?.emit("selectClue", {
      roomCode,
      catId,
      value,
      discordUserId: meRef.current?.discordUserId ?? null,
    });
  }, []);

  const judgeAnswer = useCallback((discordUserId, correct) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode) return;
    socketRef.current?.emit("judgeAnswer", { roomCode, discordUserId, correct });
    if (correct) onLocalControlChangedRef.current?.(discordUserId || null);
  }, []);

  const hostSetControl = useCallback((discordUserId) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode) return;
    socketRef.current?.emit("hostSetControl", { roomCode, discordUserId });
    onLocalControlChangedRef.current?.(discordUserId || null);
  }, []);

  // Flipped from "null = anyone's turn" to "null = nobody's turn (locked,
  // host hasn't assigned anyone yet)". A third state, OPEN_CONTROL, is what
  // now means "anyone's turn" — set explicitly by the host, not a default.
  // Matches the server's selectClue gate — see bot-server.js. This is
  // UX-only either way; the server re-validates independently.
  const isMyTurn = controlDiscordUserId === OPEN_CONTROL || (!!controlDiscordUserId && controlDiscordUserId === me?.discordUserId);

  return {
    controlDiscordUserId,
    isMyTurn,
    connected,
    selectClue,
    judgeAnswer,
    hostSetControl,
  };
}