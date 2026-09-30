// lib/hooks/useControlSync.js
import { useEffect, useState, useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";

/* =========================================================================
   useControlSync
   Tracks and updates who currently holds "board control" — i.e. who's
   allowed to pick the next category/clue. Keyed by discordUserId (stable
   across reconnects), never socket.id, same reasoning as usePlayerSync's
   team-identity handling — see bot-server.js's controlDiscordUserId notes.

   Shares the tab's single socket via SocketContext (see SocketContext.jsx)
   instead of opening its own connection — listeners are added/removed
   with socket.on/off, and `connected` now reflects the shared socket's
   state rather than a connection this hook owned itself.

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
  const { socket, connected } = useSocket();
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  // Kept in a ref (not the effect's dependency array) so a new function
  // reference from the host re-rendering doesn't tear down and re-attach
  // listeners — only the latest callback is ever invoked.
  const onClueSelectedRef = useRef(onClueSelected);
  onClueSelectedRef.current = onClueSelected;
  const onLocalControlChangedRef = useRef(onLocalControlChanged);
  onLocalControlChangedRef.current = onLocalControlChanged;

  // Same reasoning as onClueSelectedRef: selectClue below is memoized with
  // a stable dep array, so it needs a ref (not a closed-over `me`) to see
  // the latest discordUserId without being recreated every render.
  const meRef = useRef(me);
  meRef.current = me;

  useEffect(() => {
    if (!socket) return;

    const handleConnect = () => {
      if (roomCodeRef.current) socket.emit("joinRoom", roomCodeRef.current);
    };
    const handleControlChanged = ({ controlDiscordUserId: id }) => {
      setControlDiscordUserId(id ?? null);
    };
    const handleClueSelected = (payload) => {
      onClueSelectedRef.current?.(payload);
    };

    socket.on("connect", handleConnect);
    socket.on("controlChanged", handleControlChanged);
    socket.on("clueSelected", handleClueSelected);

    if (socket.connected && roomCodeRef.current) {
      socket.emit("joinRoom", roomCodeRef.current);
    }

    return () => {
      socket.off("connect", handleConnect);
      socket.off("controlChanged", handleControlChanged);
      socket.off("clueSelected", handleClueSelected);
    };
  }, [socket]);

  useEffect(() => {
    if (roomCode && socket?.connected) {
      socket.emit("joinRoom", roomCode);
    }
  }, [roomCode, socket]);

  const selectClue = useCallback(({ catId, value }) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socket) return;
    socket.emit("selectClue", {
      roomCode,
      catId,
      value,
      discordUserId: meRef.current?.discordUserId ?? null,
    });
  }, [socket]);

  const judgeAnswer = useCallback((discordUserId, correct) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socket) return;
    socket.emit("judgeAnswer", { roomCode, discordUserId, correct });
    if (correct) onLocalControlChangedRef.current?.(discordUserId || null);
  }, [socket]);

  const hostSetControl = useCallback((discordUserId) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socket) return;
    socket.emit("hostSetControl", { roomCode, discordUserId });
    onLocalControlChangedRef.current?.(discordUserId || null);
  }, [socket]);

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