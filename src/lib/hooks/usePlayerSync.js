// lib/hooks/usePlayerSync.js
import { useEffect, useState, useRef } from "react";
import { io } from "socket.io-client";

const BOT_SERVER_URL = import.meta.env.VITE_BOT_SERVER_URL ?? "";

/* =========================================================================
   usePlayerSync
   Read-only counterpart to usePersistence for players who joined via room
   code — no session/SessionStore, no autosave, just: connect, join the
   room, and keep `boardData` in sync with whatever the host last saved.

   The server (bot-server.js) sends the room's stored board snapshot right
   after joining, so a player who joins mid-game sees the current board
   immediately instead of waiting for the host's next edit.

   `me` — { id, username, discordUser } for the current logged-in player.
   When present, this hook identifies itself to the server via
   `joinAsPlayer` (which finds-or-creates a team named after `me.username`
   and attaches `me.discordUser`, if any) instead of the anonymous
   `joinRoom` used elsewhere. Falls back to `joinRoom` if `me` isn't
   available yet, so boardData/activeClue still populate.
   ========================================================================= */
export function usePlayerSync(roomCode, me) {
  const [boardData, setBoardData] = useState(null);
  const [connected, setConnected] = useState(false);
  // { catId, value, revealed } while a clue is open on the host, else null
  const [activeClue, setActiveClue] = useState(null);
  // { teamId, teamName } once the server confirms which team we joined
  const [joinedTeam, setJoinedTeam] = useState(null);
  // Array of category ids the host has reveal-clicked — mirrors the
  // host's useBoardGrid revealedCats, kept as an array over the wire
  // (Sets aren't JSON-serializable) and used as-is; PlayerView does its
  // own .includes() check rather than converting back to a Set.
  const [revealedCats, setRevealedCats] = useState([]);
  // "DOUBLE JEOPARDY!"-style round-switch banner, mirrored from the host's
  // useBoardGrid roundBanner — { text, phase: "in" | "out" } or null.
  // Same "live for the show, never persisted" treatment as revealedCats
  // and activeClue: its own tiny relay, not part of boardUpdate.
  // PlayerView also uses this SAME value (not a separate broadcast) to
  // locally time its own board flip-ripple choreography — see PlayerView's
  // comment for why a second boardFlip broadcast would race against
  // boardUpdate with no ordering guarantee between the two sockets.
  const [roundBanner, setRoundBanner] = useState(null);
  // Connected players roster, same shape/source as the host's usePersistence
  // `players` — { socketId, discordUserId, discordUsername, discordAvatarUrl,
  // teamId, role }. Lets the player view build a per-team avatar facepile
  // just like the host's, instead of only showing your own avatar.
  const [players, setPlayers] = useState([]);
  // "Now playing" background music state, mirrored from the host via
  // useBgmSync — { fileRef, fileName, loop, playing, positionSeconds,
  // updatedAt } or null when no track is loaded. Deliberately carries no
  // volume; each client's volume is local-only (see PlayerBgmWidget).
  const [bgm, setBgm] = useState(null);
  const socketRef = useRef(null);
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;
  const meRef = useRef(me);
  meRef.current = me;
  // Set once leaveGame() is called. Every join path (the 'connect' handler
  // and the roomCode/me effect below) checks this first — without it, a
  // stray reconnect or a re-render after leaving would immediately
  // re-emit joinAsPlayer and put you right back on your team.
  const hasLeftRef = useRef(false);

  function sendJoin(socket) {
    if (hasLeftRef.current) return;
    const code = roomCodeRef.current;
    if (!code) return;
    const currentMe = meRef.current;
    if (currentMe?.username) {
      socket.emit("joinAsPlayer", {
        roomCode: code,
        teamName: currentMe.username,
        discordUser: currentMe.discordUser || null,
      });
    } else {
      socket.emit("joinRoom", code);
    }
  }

  useEffect(() => {
    const socket = io(BOT_SERVER_URL);
    socketRef.current = socket;

    socket.on("connect", () => {
      if (hasLeftRef.current) return;
      setConnected(true);
      sendJoin(socket);
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("boardUpdate", ({ data }) => setBoardData(data));
    socket.on("activeClueUpdate", (payload) => setActiveClue(payload || null));
    socket.on("joinedTeam", (payload) => setJoinedTeam(payload || null));
    socket.on("revealedCatsUpdate", (ids) => setRevealedCats(Array.isArray(ids) ? ids : []));
    socket.on("roundBannerUpdate", (payload) => setRoundBanner(payload || null));
    socket.on("playersUpdate", (list) => setPlayers(Array.isArray(list) ? list : []));
    socket.on("bgmUpdate", (payload) => setBgm(payload || null));

    return () => socket.disconnect();
  }, []);

  // Re-send if the room code or player identity shows up after connect, or
  // changes (e.g. Discord identity resolves a moment after the initial
  // anonymous joinRoom already fired).
  useEffect(() => {
    if (roomCode && socketRef.current?.connected) {
      sendJoin(socketRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, me?.username, me?.discordUser?.id]);

  // Deliberate leave. Tells the server first (so the team/roster update
  // reaches the host immediately, no 12s grace-period wait), THEN tears
  // down the socket — doing it in that order means the leave message
  // can't get lost in the disconnect. hasLeftRef stops anything from
  // re-joining afterward if this hook happens to stay mounted a moment
  // longer (e.g. while the parent switches screens away from PlayerView).
  function leaveGame() {
    hasLeftRef.current = true;
    const code = roomCodeRef.current;
    const socket = socketRef.current;

    // UI should reflect "left" immediately regardless of how the network
    // call below resolves.
    setJoinedTeam(null);
    setConnected(false);

    if (!socket?.connected || !code) {
      socket?.disconnect();
      return Promise.resolve();
    }

    // Wait for the server to ack that it actually processed the leave
    // before tearing down the socket. emit() immediately followed by
    // disconnect() can drop the leaveGame message entirely — the socket
    // closes before it finishes going out over the wire, so the server
    // only ever sees the raw disconnect and falls back to the 12s grace
    // period. A timeout guards against the ack itself never arriving
    // (e.g. the server missed the message anyway) so leaveGame() can't
    // hang forever — worst case we're back to the old disconnect-only
    // behavior, not stuck.
    //
    // This returns a promise so callers (PlayerView's handleLeave) can
    // await it before navigating away — navigating unmounts this hook,
    // whose effect cleanup calls socket.disconnect() unconditionally, so
    // if navigation happens before the ack lands, the unmount-triggered
    // disconnect wins the race instead and we're back to square one.
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        socket.disconnect();
        resolve();
      };
      socket.emit("leaveGame", code, () => finish());
      setTimeout(finish, 1500);
    });
  }

  return { boardData, connected, activeClue, joinedTeam, revealedCats, roundBanner, players, bgm, leaveGame };
}