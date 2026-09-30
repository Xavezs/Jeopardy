// lib/hooks/usePlayerSync.js
import { useEffect, useState, useRef } from "react";
import { useSocket } from "../SocketContext";

/* =========================================================================
   usePlayerSync
   Read-only counterpart to usePersistence for players who joined via room
   code — no session/SessionStore, no autosave, just: connect, join the
   room, and keep `boardData` in sync with whatever the host last saved.

   The server (bot-server.js) sends the room's stored board snapshot right
   after joining, so a player who joins mid-game sees the current board
   immediately instead of waiting for the host's next edit.

   Shares the tab's single socket via SocketContext (see SocketContext.jsx)
   instead of opening its own connection. `connected` now reflects the
   shared socket's state instead of one this hook owned itself.

   IMPORTANT behavior change from the socket-per-hook version: leaveGame()
   used to call socket.disconnect() after the server acked the leave —
   safe back when this hook had its own private socket, but that same
   call would now kill the ONE socket every other hook in this tab shares
   (useBuzzer, useControlSync, useWagerSync, useFinalSync all mount
   alongside this in PlayerView.jsx). The server's leaveGame handler
   already does socket.leave(roomCode) + clears socket.gameRoomCode on its
   own (see bot-server.js), so nothing here actually needs the transport
   itself to go away — leaveGame() below now just emits/awaits the ack and
   resets local join state, leaving the shared socket connected for
   whatever screen the player lands on next.

   `me` — { id, username, discordUser } for the current logged-in player.
   When present, this hook identifies itself to the server via
   `joinAsPlayer` (which finds-or-creates a team named after `me.username`
   and attaches `me.discordUser`, if any) instead of the anonymous
   `joinRoom` used elsewhere. Falls back to `joinRoom` if `me` isn't
   available yet, so boardData/activeClue still populate.
   ========================================================================= */
export function usePlayerSync(roomCode, me, onRoomCodeChanged) {
  const [boardData, setBoardData] = useState(null);
  const { socket, connected } = useSocket();
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
  // Team randomizer state, mirrored from the host via useRandomizerSync —
  // { active, spinning, order, startedAt } or null when the host isn't on
  // the randomizer screen. Same "live for the show" treatment as
  // revealedCats/bgm: resent on (re)join by the server, not part of
  // boardUpdate. See TeamRandomizer.jsx's readOnly mode for how this
  // drives the player's own reel animation replay.
  const [randomizer, setRandomizer] = useState(null);
  // Per-player correct/wrong counts the server tracks off judgeAnswer —
  // { [discordUserId]: { correct, wrong } }. Same "live for the show,
  // resent on join" treatment as bgm/randomizer above (see bot-server.js's
  // joinRoom/joinAsPlayer handlers). Used by FinalJeopardyView to show a
  // per-player stats breakdown alongside Final Standings.
  const [playerStats, setPlayerStats] = useState({});
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;
  const meRef = useRef(me);
  meRef.current = me;
  const onRoomCodeChangedRef = useRef(onRoomCodeChanged);
  onRoomCodeChangedRef.current = onRoomCodeChanged;
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
    if (!socket) return;

    const handleConnect = () => {
      if (hasLeftRef.current) return;
      sendJoin(socket);
    };
    const handleBoardUpdate = ({ data }) => setBoardData(data);
    const handleActiveClueUpdate = (payload) => setActiveClue(payload || null);
    const handleJoinedTeam = (payload) => setJoinedTeam(payload || null);
    const handleRevealedCatsUpdate = (ids) => setRevealedCats(Array.isArray(ids) ? ids : []);
    const handleRoundBannerUpdate = (payload) => setRoundBanner(payload || null);
    const handlePlayersUpdate = (list) => setPlayers(Array.isArray(list) ? list : []);
    const handleBgmUpdate = (payload) => setBgm(payload || null);
    const handleRandomizerUpdate = (payload) => setRandomizer(payload || null);
    const handleStatsUpdate = (stats) => setPlayerStats(stats || {});
    const handleRoomCodeChanged = ({ roomCode: nextRoomCode }) => {
      if (typeof nextRoomCode === "string" && nextRoomCode.trim()) {
        onRoomCodeChangedRef.current?.(nextRoomCode.trim().toUpperCase());
      }
    };

    socket.on("connect", handleConnect);
    socket.on("boardUpdate", handleBoardUpdate);
    socket.on("activeClueUpdate", handleActiveClueUpdate);
    socket.on("joinedTeam", handleJoinedTeam);
    socket.on("revealedCatsUpdate", handleRevealedCatsUpdate);
    socket.on("roundBannerUpdate", handleRoundBannerUpdate);
    socket.on("playersUpdate", handlePlayersUpdate);
    socket.on("bgmUpdate", handleBgmUpdate);
    socket.on("randomizerUpdate", handleRandomizerUpdate);
    socket.on("statsUpdate", handleStatsUpdate);
    socket.on("roomCodeChanged", handleRoomCodeChanged);

    // Socket may already be connected (shared across hooks that mount at
    // slightly different times) — join immediately rather than waiting
    // for a 'connect' event that already fired.
    if (socket.connected) handleConnect();

    return () => {
      socket.off("connect", handleConnect);
      socket.off("boardUpdate", handleBoardUpdate);
      socket.off("activeClueUpdate", handleActiveClueUpdate);
      socket.off("joinedTeam", handleJoinedTeam);
      socket.off("revealedCatsUpdate", handleRevealedCatsUpdate);
      socket.off("roundBannerUpdate", handleRoundBannerUpdate);
      socket.off("playersUpdate", handlePlayersUpdate);
      socket.off("bgmUpdate", handleBgmUpdate);
      socket.off("randomizerUpdate", handleRandomizerUpdate);
      socket.off("statsUpdate", handleStatsUpdate);
      socket.off("roomCodeChanged", handleRoomCodeChanged);
    };
  }, [socket]);

  // Re-send if the room code or player identity shows up after connect, or
  // changes (e.g. Discord identity resolves a moment after the initial
  // anonymous joinRoom already fired). Watches avatarUrl/username too, not
  // just discordUser.id — the id can stay the same while a stale/blank
  // avatarUrl from an earlier failed resolution gets replaced by a fresh
  // one, and that needs to reach the server (and everyone else, since the
  // roster/avatar broadcast to the host + other players is keyed off
  // whatever was last sent here) or the whole app stays stuck on the old
  // value even though PlayerView already has the correct one locally.
  useEffect(() => {
    if (roomCode && socket?.connected) {
      sendJoin(socket);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, socket, me?.username, me?.discordUser?.id, me?.discordUser?.avatarUrl]);

  // Deliberate leave. Tells the server first (so the team/roster update
  // reaches the host immediately, no 12s grace-period wait). hasLeftRef
  // stops anything from re-joining afterward if this hook happens to stay
  // mounted a moment longer (e.g. while the parent switches screens away
  // from PlayerView).
  //
  // Does NOT disconnect the socket anymore — it's shared with every other
  // hook in this tab (see the header comment above). The server's
  // leaveGame handler already removes this player/team on its own; all
  // that's left to do locally is wait for its ack (or time out) and reset
  // join state.
  function leaveGame() {
    hasLeftRef.current = true;
    const code = roomCodeRef.current;

    // UI should reflect "left" immediately regardless of how the network
    // call below resolves.
    setJoinedTeam(null);

    if (!socket?.connected || !code) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      socket.emit("leaveGame", code, () => finish());
      setTimeout(finish, 1500);
    });
  }

  return { boardData, connected, activeClue, joinedTeam, revealedCats, roundBanner, players, bgm, randomizer, playerStats, leaveGame };
}