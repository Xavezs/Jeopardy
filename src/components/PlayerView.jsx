import React, { useState, useEffect, useMemo, useRef } from "react";
import "../styles/player.css";
import "../styles/board.css"; // TeamCard's classes (.team-card, .team-discord-avatar, etc.) are defined here — this file never needed them before it built its own team markup.
import { usePlayerSync } from "../lib/hooks/usePlayerSync";
import { useBuzzer } from "../lib/hooks/useBuzzer";
import { useControlSync } from "../lib/hooks/useControlSync";
import { useSpeakingState } from "../lib/hooks/useSpeakingState";
import { useDiscordMembers } from "../lib/hooks/useDiscordMembers";
import { getMediaUrl, isGoogleDriveUrl, extractGoogleDriveFileId, resolveGoogleDriveMediaType } from "../lib/storage";
import { youTubeEmbed } from "../lib/utils";
import { getDiscordIdentity, activityChannelId } from "../discordSdk";
import MarqueeBulbs from "../lib/MarqueeBulbs";
import TeamCard from "./TeamCard";
import {
  playCorrectSfx,
  playIncorrectSfx,
  playCatRevealSfx,
} from "../lib/boardSfx";
import CustomAudioPlayer from "./CustomAudioPlayer";
import CustomVideoPlayer from "./CustomVideoPlayer";
import PlayerBgmWidget from "./PlayerBgmWidget";

function readRoomCodeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("room");
  return code ? code.toUpperCase() : "";
}

function randomPlayerId() {
  return "p_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Called when the player deliberately leaves — without this, "Leave" only
// ever hid the screen; coming back to the same room code would silently
// restore `me` from here and rejoin automatically.
function clearCachedIdentity(roomCode) {
  const code = roomCode?.trim().toUpperCase();
  if (!code) return;
  localStorage.removeItem(`jeopardy:player:${code}:id`);
  localStorage.removeItem(`jeopardy:player:${code}:name`);
  localStorage.removeItem(`jeopardy:player:${code}:discordUser`);
}

function BuzzStatusText({ buzzerLive, iHaveFloor, alreadyBuzzed, myPosition, idle, className = "" }) {
  const text = idle
    ? "Buzzer is closed — wait for the host…"
    : !buzzerLive
    ? "Buzzer is closed — wait for the host…"
    : iHaveFloor
    ? "You have the floor — go!"
    : alreadyBuzzed
    ? `Buzzed in — you're #${myPosition} in line.`
    : "Buzzer is ready!";
  return <div className={"pv-buzzer-status " + className}>{text}</div>;
}

// Team scoreboard — now backed by the same TeamCard component the host
// uses (instead of a second, hand-rolled facepile), so speaking state,
// mute/deafen badges, and any future TeamCard changes automatically apply
// here too instead of needing to be built twice. Rendered fully read-only:
// editMode is always false, and every edit-only callback (rename, remove,
// setTeamScore, toggleTeamDiscordUser) is a no-op since players never
// touch team management — those controls simply never render because
// TeamCard only shows them when editMode is true.
function TeamScoreRow({ teams, joinedTeamId, pulseMap, compact, discordMembersByTeam, buzzStateByTeam }) {
  if (!teams?.length) return null;
  const sortedTeams = useMemo(() => {
    return [...teams].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }, [teams]);

  return (
    <div className={"pv-teams" + (compact ? " pv-teams-compact" : "")}>
      {sortedTeams.map((team, i) => {
        const buzzState = buzzStateByTeam?.[team.id];
        return (
          <div
            key={team.id}
            className={"pv-team-card-wrap" + (joinedTeamId === team.id ? " pv-team-mine" : "")}
          >
            <TeamCard
              team={team}
              teamIndex={i}
              editMode={false}
              selectedScoreTeamId={null}
              setSelectedScoreTeamId={() => {}}
              discordDisplayMode="discord"
              discordTeamMembers={discordMembersByTeam?.[team.id] || []}
              discordMembers={[]}
              toggleTeamDiscordUser={() => {}}
              removeTeam={() => {}}
              renameTeam={() => {}}
              setTeamScore={() => {}}
              scorePulse={pulseMap}
              buzzPosition={buzzState?.position ?? null}
              buzzIsActive={buzzState?.isActive ?? false}
              buzzIsStruck={buzzState?.isStruck ?? false}
            />
          </div>
        );
      })}
    </div>
  );
}

export default function PlayerView() {
  // Discord Activities run inside an iframe embedded in Discord's own UI.
  // On first load, keyboard focus sits on Discord's parent frame, not this
  // iframe — so keydown events (like the buzzer's spacebar shortcut) never
  // reach us until something inside the iframe grabs focus. A click does
  // that implicitly; this does it proactively so players don't have to
  // click first before Space works.
  useEffect(() => {
    window.focus();
  }, []);

  // Click/hover sfx is installed once at the App root (covers this join
  // form and every other screen in the app) — see App.jsx, not here.
  const [roomCode, setRoomCode] = useState(readRoomCodeFromUrl());
  const [nameInput, setNameInput] = useState("");
  const [me, setMe] = useState(null);

  // Resolve Discord identity as early as possible (mount), independent of
  // roomCode/name — so by the time someone hits "Join Game" we already
  // know their Discord username/avatar and can fall back to it if they
  // left the name field blank, instead of only finding out after submit.
  const [discordUser, setDiscordUser] = useState(null);
  const [discordChecked, setDiscordChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let user = null;
      try {
        user = await getDiscordIdentity();
      } catch (err) {
        console.warn("Discord identity resolution failed, continuing without it:", err.message);
      }
      if (!cancelled) {
        setDiscordUser(user);
        setDiscordChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!roomCode) return;
    const savedName = localStorage.getItem(`jeopardy:player:${roomCode}:name`);
    const savedId = localStorage.getItem(`jeopardy:player:${roomCode}:id`);
    const savedDiscordUser = localStorage.getItem(`jeopardy:player:${roomCode}:discordUser`);
    if (savedName && savedId) {
      setMe({
        id: savedId,
        username: savedName,
        discordUser: savedDiscordUser ? JSON.parse(savedDiscordUser) : null,
      });
    }
  }, [roomCode]);

  // The effect above can restore `me` from a PAST join, cached in
  // localStorage — including a null discordUser from back when Discord
  // auth wasn't working yet. That skips the join form entirely (see
  // `if (!me)` below), so nothing else ever gets a chance to attach a
  // freshly-resolved Discord identity to `me`. Once identity resolution
  // finishes, reconcile: if what we now know from Discord doesn't match
  // what's on `me`, update both `me` and the cached copy. This also
  // self-heals automatically if the user's Discord identity changes for
  // any other reason (re-auth, different account, etc.).
  useEffect(() => {
    if (!discordChecked || !me) return;
    const cached = me.discordUser;
    const fresh = discordUser;
    // Deep-compare, not just id — id staying the same doesn't mean nothing
    // changed. A prior session can have cached a discordUser with a missing
    // avatarUrl (e.g. identity resolution failed or raced last time), and
    // comparing ids only would leave that stale/blank avatar stuck forever
    // even after a fresh, fully-populated identity resolves this time.
    const changed =
      (cached?.id || null) !== (fresh?.id || null) ||
      (cached?.avatarUrl || null) !== (fresh?.avatarUrl || null) ||
      (cached?.username || null) !== (fresh?.username || null);
    if (!changed) return;

    const code = roomCode?.trim().toUpperCase();
    if (code) {
      if (fresh) {
        localStorage.setItem(`jeopardy:player:${code}:discordUser`, JSON.stringify(fresh));
      } else {
        localStorage.removeItem(`jeopardy:player:${code}:discordUser`);
      }
    }
    setMe((prev) => (prev ? { ...prev, discordUser: fresh } : prev));
  }, [discordChecked, discordUser, me, roomCode]);

  const [joining, setJoining] = useState(false);

  function handleJoin(e) {
    e.preventDefault();
    const code = roomCode.trim().toUpperCase();
    // Blank name -> fall back to the resolved Discord username, if any.
    const name = nameInput.trim() || discordUser?.username || "";
    if (!code || !name) return;

    let id = localStorage.getItem(`jeopardy:player:${code}:id`);
    if (!id) {
      id = randomPlayerId();
      localStorage.setItem(`jeopardy:player:${code}:id`, id);
    }
    localStorage.setItem(`jeopardy:player:${code}:name`, name);

    if (discordUser) {
      localStorage.setItem(`jeopardy:player:${code}:discordUser`, JSON.stringify(discordUser));
    } else {
      localStorage.removeItem(`jeopardy:player:${code}:discordUser`);
    }

    setRoomCode(code);
    setMe({ id, username: name, discordUser });
  }

  if (!me) {
    const namePlaceholder = discordUser?.username
      ? `Leave blank to join as "${discordUser.username}"`
      : "How you'll appear on the buzzer";
    return (
      <div className="pv-root pv-center">
        <form className="pv-join-card" onSubmit={handleJoin}>
          <h1>Join a Game</h1>
          <label>
            Room Code
            <input
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              placeholder="e.g. K7QX9M"
              maxLength={8}
              autoCapitalize="characters"
              required
            />
          </label>
          <label>
            Your Name
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder={namePlaceholder}
              maxLength={24}
            />
          </label>
          <button
            type="submit"
            className="pv-btn pv-btn-primary"
            disabled={joining || !discordChecked}
          >
            {!discordChecked ? "Checking Discord…" : joining ? "Joining…" : "Join Game"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <PlayerBoard
      roomCode={roomCode}
      me={me}
      onLeave={() => {
        window.history.pushState({}, '', '/');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }}
    />
  );
}

function PlayerBoard({ roomCode, me, onLeave }) {
  const { boardData, connected, activeClue, joinedTeam, revealedCats, roundBanner, players, bgm, leaveGame } = usePlayerSync(roomCode, me);

  // The actual "I'm leaving" action. Tells the server immediately (skips
  // the 12s disconnect grace period entirely, since this is deliberate),
  // wipes the cached identity so coming back to this room code starts
  // fresh instead of silently rejoining, then hands off to the parent's
  // onLeave for navigation.
  async function handleLeave() {
    await leaveGame();
    clearCachedIdentity(roomCode);
    onLeave();
  }

  // Click/hover sfx is installed once at the PlayerView root (covers the
  // join form too) — see there, not here.


  // The host plays a "reveal" sound locally (inside ClueModal) whenever it
  // flips the question card or toggles the answer — but that's a direct
  // local function call, not something published over the socket. The
  // underlying state IS already synced though (activeClue.flipped /
  // .revealed), so watch for those transitions here and play the same
  // category-reveal cue (same reveal-card.mp3 asset) locally instead of
  // needing a new event just for this.
  const prevClueFlagsRef = useRef({ flipped: false, revealed: false });
  useEffect(() => {
    const prev = prevClueFlagsRef.current;
    const flipped = !!activeClue?.flipped;
    const revealed = !!activeClue?.revealed;
    if (flipped !== prev.flipped || revealed !== prev.revealed) {
      if (flipped || revealed) playCatRevealSfx();
    }
    prevClueFlagsRef.current = { flipped, revealed };
  }, [activeClue?.flipped, activeClue?.revealed]);

  // Same idea for category reveals — revealedCats is already synced, the
  // host just never told anyone else to make a sound when it grows.
  const prevRevealedCountRef = useRef(0);
  useEffect(() => {
    const count = revealedCats?.length || 0;
    if (count > prevRevealedCountRef.current) playCatRevealSfx();
    prevRevealedCountRef.current = count;
  }, [revealedCats]);

  // The host side (ClueModal) matches buzz-queue entries against Discord
  // user ids — that's how it resolves which *team* is buzzed in and
  // highlights the right avatar in the per-team facepile. `me.id` is just
  // our own locally-generated `p_...` id and will never match a Discord
  // id, so if this player has a linked Discord identity, buzz in with
  // THAT id instead. `me.id` itself is left untouched everywhere else
  // (localStorage keys, usePlayerSync, team join logic, etc.) — this
  // only changes what goes out over the buzzer channel.
  const buzzerMe = useMemo(
    () => ({
      id: me.discordUser?.id || me.id,
      username: me.username,
      avatarUrl: me.discordUser?.avatarUrl,
    }),
    [me.id, me.username, me.discordUser?.id, me.discordUser?.avatarUrl]
  );

  const { queue, activePlayer, alreadyBuzzed, buzz, buzzerLive } = useBuzzer(roomCode, buzzerMe);

  // Board control: who's currently allowed to pick the next category/clue.
  // Keyed by discordUserId (same stable id buzzerMe already uses), NOT this
  // player's local `me.id` — see useControlSync.js for why.
  const { controlDiscordUserId, isMyTurn, selectClue } = useControlSync(roomCode, {
    discordUserId: buzzerMe.id,
  });

  // Display name for whoever currently holds the board, for the "whose
  // turn" indicator — resolved from the synced players roster rather than
  // carried separately, since the roster already has discordUserId +
  // discordUsername for everyone connected.
  const controlHolderName = useMemo(() => {
    if (!controlDiscordUserId) return null;
    const holder = players.find((p) => p.discordUserId === controlDiscordUserId);
    return holder?.discordUsername || null;
  }, [controlDiscordUserId, players]);

  // If the room code is wrong (or points at a board the host hasn't
  // opened yet), the socket still connects fine but boardData never
  // arrives — there's no server-side error to catch, just silence. Give
  // up waiting after a few seconds so the person isn't stuck on a
  // "waiting for host" screen with no way out short of restarting the
  // whole Discord Activity.
  const [waitTimedOut, setWaitTimedOut] = useState(false);
  useEffect(() => {
    if (boardData) {
      setWaitTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setWaitTimedOut(true), 8000);
    return () => clearTimeout(timer);
  }, [boardData, roomCode]);

  const myPosition = useMemo(() => {
    const idx = queue.findIndex((p) => p.id === buzzerMe.id);
    return idx === -1 ? null : idx + 1;
  }, [queue, buzzerMe.id]);

  const iHaveFloor = activePlayer?.id === buzzerMe.id;

  const playersByTeam = useMemo(() => {
    const map = {};
    for (const p of players) {
      if (!p.teamId) continue;
      if (!map[p.teamId]) map[p.teamId] = [];
      map[p.teamId].push(p);
    }
    return map;
  }, [players]);

  // 0-based index of whoever currently holds the buzzer, derived from
  // `activePlayer` the same way ClueModal derives `buzzerActiveIndex` on
  // the host side (queue.findIndex against the winner's id) — the player
  // hook doesn't expose activeIndex directly since it's built for a
  // single participant's perspective, not an observer's.
  const buzzActiveIndex = useMemo(
    () => (activePlayer ? queue.findIndex((p) => p.id === activePlayer.id) : -1),
    [queue, activePlayer]
  );

  // Maps each team to its buzz-queue state: position (1-based) of the
  // earliest of its members currently buzzed in, whether that member is
  // the one currently holding the floor, and whether they've already had
  // their turn and been passed over. Mirrors the per-avatar badge logic
  // ClueModal runs on the host side, just rolled up to one badge per team
  // (TeamCard shows a single corner badge, not one per member) — if any
  // of the team's queued members is the active one, that member's spot
  // wins over an earlier-but-now-inactive one. Queue entries key off
  // `buzzerMe.id` (a Discord id when linked, otherwise the local
  // `p_...` id — see buzzerMe above), so a roster entry can match on
  // either its own id or its discordUserId.
  const buzzStateByTeam = useMemo(() => {
    if (!queue.length) return {};
    const idToTeam = {};
    for (const p of players) {
      if (!p.teamId) continue;
      idToTeam[p.id] = p.teamId;
      if (p.discordUserId) idToTeam[p.discordUserId] = p.teamId;
    }
    const map = {};
    queue.forEach((q, i) => {
      const teamId = idToTeam[q.id];
      if (!teamId) return;
      const isActive = !!activePlayer && activePlayer.id === q.id;
      const isStruck = !isActive && i < buzzActiveIndex;
      if (!map[teamId] || isActive) {
        map[teamId] = { position: i + 1, isActive, isStruck };
      }
    });
    return map;
  }, [queue, players, activePlayer, buzzActiveIndex]);

  // Live "who's talking" — same client-side SDK source useTeams.js uses on
  // the host side (see useSpeakingState.js). Every client independently
  // subscribes to the same voice channel's RPC events, so this needs no
  // socket relay to stay in sync with the host's view.
  const speakingIds = useSpeakingState();

  // Real mute/deafen state for everyone in the voice channel, sourced from
  // the bot server the same way the host does (useDiscordMembers) — not a
  // self-only check, so a teammate's mute badge shows up here too, live,
  // without needing a separate detection path. Degrades gracefully to an
  // empty list (badges just don't show, same as before) in standalone
  // browser mode where activityChannelId is null.
  const { members: voiceMembers } = useDiscordMembers(activityChannelId);
  const voiceStateById = useMemo(() => {
    const map = {};
    voiceMembers.forEach((m) => { map[m.id] = m; });
    return map;
  }, [voiceMembers]);

  // Reshapes playersByTeam (roster entries keyed by socket/team) into what
  // TeamCard expects: { id, avatarUrl, speaking, muted, deafened } per
  // member, keyed by teamId.
  const discordMembersByTeam = useMemo(() => {
    const map = {};
    Object.entries(playersByTeam).forEach(([teamId, roster]) => {
      map[teamId] = roster
        .filter((p) => p.discordUserId)
        .map((p) => {
          const voiceState = voiceStateById[p.discordUserId];
          return {
            id: p.discordUserId,
            avatarUrl: p.discordAvatarUrl,
            speaking: speakingIds.has(p.discordUserId),
            muted: !!voiceState?.muted,
            deafened: !!voiceState?.deafened,
          };
        });
    });
    return map;
  }, [playersByTeam, speakingIds, voiceStateById]);

  const openClue = useMemo(() => {
    if (!activeClue || !boardData || !boardData.rounds) return null;
    const rd = boardData.rounds[boardData.currentRound] || boardData.rounds[0];
    if (!rd || !rd.categories) return null;

    const cat = rd.categories.find((c) => c.id === activeClue.catId);
    const clue = cat?.clues?.[activeClue.value];
    if (!cat || !clue) return null;

    // activeClue is published verbatim by the host's useClueSync as
    // { catId, value, revealed, flipped, isPlaying, currentTime } — no
    // renaming happens in between, so map straight off those fields.
    const questionRev = Boolean(activeClue.flipped);
    const answerRev = Boolean(activeClue.revealed);

    return {
      categoryName: cat.name,
      value: activeClue.value,
      question: clue.question,
      answer: clue.answer,
      questionRevealed: questionRev,
      revealed: answerRev,
      mediaUrl: clue.mediaUrl,
      mediaType: clue.mediaType,
      answerMediaUrl: clue.answerMediaUrl,
      answerMediaType: clue.answerMediaType,
      isPlaying: activeClue.isPlaying,
      currentTime: activeClue.currentTime,
    };
  }, [activeClue, boardData]);

  const buzzDisabled = !buzzerLive || iHaveFloor || alreadyBuzzed;
  const buzzBarActive = buzzerLive || alreadyBuzzed || iHaveFloor;

  /* ---------------- LOCAL BOARD FLIP RIPPLE ----------------
     The host's disappear/reappear column ripple (useBoardGrid.js's
     boardFlip: "idle" -> "out" -> [data swaps] -> "in-start" -> "in")
     is timing-critical — the fade-out has to play on the OLD categories
     before they're replaced. Relaying that phase as its own broadcast
     would travel over a separate socket from the one that delivers the
     actual boardUpdate (new categories), with no guarantee which arrives
     first — so instead this runs the identical choreography locally,
     using the SAME constants as the host, triggered off `roundBanner`
     going null -> { phase: "in" }, which is already reliably delivered
     (it's just text, not timing-sensitive) and fires at the exact moment
     the host's switchRound() does.

     IMPORTANT: the "pop back in" (in-start -> in) must NOT fire on a
     fixed local timer alone. The host swaps its round data synchronously,
     in local memory, right as its own timer elapses — but the PLAYER only
     finds out about that swap once the real `boardUpdate` arrives over
     the network, which takes however long the round trip takes. A fixed
     timer here would assume that packet always arrives instantly, and
     under any real lag the board pops back in still showing the OLD
     numbers for a beat, only re-rendering once boardUpdate actually
     lands — which is exactly the "reappears too early" bug. So the
     reveal instead waits for BOTH: the minimum animation duration AND
     confirmation (via the boardData effect below) that
     boardData.currentRound has actually changed — whichever finishes
     last is what triggers the pop-in. A generous fallback timer still
     forces the reveal if boardUpdate is ever dropped entirely, so the
     board can't get stuck invisible forever. */
  const BANNER_HOLD_MS = 750; // must match useBoardGrid.js
  const FLIP_STAGGER_MS = 45; // must match useBoardGrid.js
  const FLIP_CELL_MS = 200; // must match useBoardGrid.js / board.css transition duration
  const SWAP_FALLBACK_MS = 2500; // safety net if boardUpdate never arrives

  const [boardFlip, setBoardFlip] = useState("idle");
  const flipTimeoutsRef = useRef([]);
  const prevBannerPhaseRef = useRef(null);
  const boardDataRef = useRef(boardData);
  boardDataRef.current = boardData;
  // Mutable flip-in-progress state shared between the two effects below —
  // refs (not state) since neither flag should trigger its own re-render,
  // they just gate when `revealBoard()` is allowed to fire.
  const flipStateRef = useRef({ awaitingSwap: false, minDurationDone: false, dataArrived: false, outDuration: 0 });

  function revealBoard() {
    const s = flipStateRef.current;
    if (!s.awaitingSwap || !s.minDurationDone || !s.dataArrived) return;
    s.awaitingSwap = false;
    setBoardFlip("in-start");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setBoardFlip("in");
        const tIdle = setTimeout(() => setBoardFlip("idle"), s.outDuration);
        flipTimeoutsRef.current.push(tIdle);
      });
    });
  }

  // Kicks off the fade-out the moment the round banner appears, then arms
  // the two gates (min duration + data arrival) that revealBoard() waits on.
  useEffect(() => {
    const prevPhase = prevBannerPhaseRef.current;
    prevBannerPhaseRef.current = roundBanner?.phase ?? null;

    // Only trigger on the null -> "in" transition (banner just appeared),
    // not on "in" -> "out" (banner already fading, flip already scheduled).
    if (roundBanner?.phase !== "in" || prevPhase != null) return;

    flipTimeoutsRef.current.forEach(clearTimeout);
    flipTimeoutsRef.current = [];

    const tOut = setTimeout(() => {
      setBoardFlip("out");

      // Column count for the OUTGOING round — read at the moment the fade
      // starts, same as the host reading `rd.categories.length` before swap.
      const roundBeforeSwitch = boardDataRef.current?.currentRound;
      const rd0 = boardDataRef.current?.rounds?.[roundBeforeSwitch];
      const catCount = rd0?.categories?.length || 1;
      const outDuration = (catCount - 1) * FLIP_STAGGER_MS + FLIP_CELL_MS;

      flipStateRef.current = { awaitingSwap: true, minDurationDone: false, dataArrived: false, outDuration, roundBeforeSwitch };

      const tMinDuration = setTimeout(() => {
        flipStateRef.current.minDurationDone = true;
        revealBoard();
      }, outDuration);
      flipTimeoutsRef.current.push(tMinDuration);

      // Safety net: force the reveal even if boardUpdate never shows up,
      // so a dropped packet can't leave the board invisible forever.
      const tFallback = setTimeout(() => {
        if (flipStateRef.current.awaitingSwap) {
          flipStateRef.current.dataArrived = true;
          revealBoard();
        }
      }, outDuration + SWAP_FALLBACK_MS);
      flipTimeoutsRef.current.push(tFallback);
    }, BANNER_HOLD_MS);
    flipTimeoutsRef.current.push(tOut);
  }, [roundBanner]);

  // Watches for the real round swap to actually land. Only matters while
  // we're mid-animation waiting on it (awaitingSwap) — otherwise a normal
  // boardUpdate (e.g. a clue being marked used) would false-trigger this.
  useEffect(() => {
    const s = flipStateRef.current;
    if (s.awaitingSwap && boardData?.currentRound !== s.roundBeforeSwitch) {
      s.dataArrived = true;
      revealBoard();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardData?.currentRound]);

  useEffect(() => {
    return () => flipTimeoutsRef.current.forEach(clearTimeout);
  }, []);

  function flipDelay(catIndex) {
    return boardFlip === "idle" ? "0ms" : `${catIndex * FLIP_STAGGER_MS}ms`;
  }

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key !== " " && e.code !== "Space") return;
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      e.preventDefault();
      if (e.repeat || buzzDisabled) return;
      buzz();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [buzzDisabled, buzz]);

  const [mediaUrl, setMediaUrl] = useState("");
  const [renderAs, setRenderAs] = useState("");
  const [answerMediaUrl, setAnswerMediaUrl] = useState("");
  const [answerRenderAs, setAnswerRenderAs] = useState("");

  useEffect(() => {
    let cancelled = false;

    // Same fix as ClueModal.jsx: a stored mediaType wins if we have one.
    // Otherwise, for a Drive link specifically, ask the server what the
    // file's real mimeType is (cheap metadata-only call, no download)
    // instead of blindly guessing "image" first and cascading on error.
    // That guess-and-check was letting audio files silently succeed
    // inside the video player (a <video> tag will often play audio-only
    // bytes just fine) instead of ever reaching the audio player — this
    // view was the one place that guess-and-check hadn't been replaced
    // yet, which is why the host and player could disagree on the same
    // clue's media type.
    async function resolveRenderType(rawRef, resolvedUrl, storedType) {
      if (storedType) return storedType;
      if (isGoogleDriveUrl(rawRef)) {
        const fileId = extractGoogleDriveFileId(rawRef);
        const detected = fileId ? await resolveGoogleDriveMediaType(fileId) : "";
        if (detected) return detected;
      }
      return resolvedUrl ? "image" : "";
    }

    async function resolve() {
      const url = openClue?.mediaUrl ? await getMediaUrl(openClue.mediaUrl) : "";
      const aUrl = openClue?.answerMediaUrl ? await getMediaUrl(openClue.answerMediaUrl) : "";
      if (cancelled) return;
      setMediaUrl(url);
      setAnswerMediaUrl(aUrl);

      const [type, answerType] = await Promise.all([
        resolveRenderType(openClue?.mediaUrl, url, openClue?.mediaType),
        resolveRenderType(openClue?.answerMediaUrl, aUrl, openClue?.answerMediaType),
      ]);
      if (cancelled) return;
      setRenderAs(type);
      setAnswerRenderAs(answerType);
    }
    resolve();

    return () => {
      cancelled = true;
    };
  }, [openClue?.mediaUrl, openClue?.mediaType, openClue?.answerMediaUrl, openClue?.answerMediaType]);

  const prevScoresRef = useRef({});
  const [pulseMap, setPulseMap] = useState({});

  useEffect(() => {
    if (!boardData?.teams) return;
    const changed = {};
    boardData.teams.forEach((team) => {
      const prev = prevScoresRef.current[team.id];
      if (prev !== undefined && prev !== team.score) {
        changed[team.id] = team.score > prev ? "pulse-up" : "pulse-down";
      }
      prevScoresRef.current[team.id] = team.score;
    });
    if (Object.keys(changed).length === 0) return;
    setPulseMap((m) => ({ ...m, ...changed }));
    // Same score-change detection that drives the pulse animation also
    // drives the sound — the host's adjustTeamScore() plays these locally
    // on its own machine only, so without this the player never hears
    // anything for a scoring event, even though the score change itself
    // (boardData.teams) is already synced.
    if (Object.values(changed).some((dir) => dir === "pulse-up")) playCorrectSfx();
    else playIncorrectSfx();
    const timers = Object.keys(changed).map((id) =>
      setTimeout(() => {
        setPulseMap((m) => {
          const copy = { ...m };
          delete copy[id];
          return copy;
        });
      }, 500)
    );
    return () => timers.forEach(clearTimeout);
  }, [boardData?.teams]);

  if (!boardData) {
    return (
      <div className="pv-root pv-center">
        <div className="pv-status">
          {waitTimedOut ? (
            <>
              <p>
                Couldn't find room {roomCode}. The code may be wrong, or the host hasn't opened this board yet.
              </p>
              <button className="pv-btn pv-btn-primary" onClick={handleLeave}>
                Try a different code
              </button>
            </>
          ) : connected ? (
            `Connected. Waiting for the host's board (room ${roomCode})…`
          ) : (
            "Connecting…"
          )}
        </div>
      </div>
    );
  }

  const rd = boardData.rounds?.[boardData.currentRound] || boardData.rounds?.[0];

  if (!rd) {
    return (
      <div className="pv-root pv-center">
        <div className="pv-status">
          <p>Waiting for round configuration...</p>
          <button className="pv-btn pv-btn-primary" onClick={handleLeave}>
            Leave
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pv-root">
      {roundBanner && (
        <div className={"round-banner" + (roundBanner.phase === "out" ? " round-banner-out" : "")}>
          <MarqueeBulbs />
          <div className="round-banner-text">{roundBanner.text}</div>
        </div>
      )}

      <div className="pv-title-banner">
        <MarqueeBulbs />
        <div className="pv-title">{boardData.title || "Jeopardy"}</div>
      </div>
      <div className="pv-room-bar">
        Room {roomCode} · {me.username}
        <button className="pv-leave" onClick={handleLeave} title="Leave and return to page selection">
          Leave
        </button>
      </div>

      {!openClue && (
        <div className={"pv-control-indicator" + (isMyTurn ? " pv-control-mine" : "")}>
          {isMyTurn
            ? "Your turn to pick a clue"
            : controlDiscordUserId
            ? `Waiting on ${controlHolderName || "another player"} to pick`
            : "Waiting for the host to open the board"}
        </div>
      )}

      {/* Floating Leave button — the room bar above gets covered by
          .pv-clue-overlay whenever a clue is open, which made "Leave"
          unreachable mid-question. This renders on top of the overlay
          (fixed position, high z-index in CSS) so players can always
          bail out, e.g. if the game freezes or they need to disconnect
          mid-clue, without waiting for the clue to close first. */}
      {openClue && (
        <button
          className="pv-leave pv-leave-floating"
          onClick={handleLeave}
          title="Leave and return to page selection"
        >
          Leave
        </button>
      )}

      {openClue && (
        <div className="pv-clue-overlay">
          <div className="pv-clue-flip-outer">
            <div className={"pv-clue-flip-inner" + (openClue.questionRevealed ? " is-flipped" : "")}>
              <div className="pv-clue-flip-face pv-clue-flip-front">
                <div className="pv-clue-front-cat">{openClue.categoryName}</div>
                <div className="pv-clue-front-val">${openClue.value}</div>
                <div className="pv-clue-front-hint">Waiting for host to reveal...</div>
              </div>

              <div className="pv-clue-flip-face pv-clue-flip-back">
                <div className="pv-clue-cat-value">
                  <div className="pv-clue-cat">{openClue.categoryName}</div>
                  <div className="pv-clue-value">${openClue.value}</div>
                </div>
                <div className="pv-clue-question">{openClue.question || "(no question text set)"}</div>

                {mediaUrl && renderAs && (
                  <div className="pv-clue-media">
                    {renderAs === "image" && (
                      <img src={mediaUrl} alt="" onError={() => setRenderAs("video")} />
                    )}
                    {renderAs === "video" &&
                      (youTubeEmbed(mediaUrl) ? (
                        <iframe
                          src={youTubeEmbed(mediaUrl)}
                          allow="autoplay; encrypted-media; picture-in-picture"
                          allowFullScreen
                          title="clue-video"
                        />
                      ) : (
                        <CustomVideoPlayer 
                          src={mediaUrl} 
                          onError={() => setRenderAs("audio")} 
                          disablePlayPause={true}
                          disableSeeking={true}
                          isPlaying={openClue.isPlaying}
                          currentTime={openClue.currentTime}
                        />
                      ))}
                    {renderAs === "audio" && (
                      <CustomAudioPlayer 
                        src={mediaUrl} 
                        disablePlayPause={true}
                        disableSeeking={true}
                        isPlaying={openClue.isPlaying}
                        currentTime={openClue.currentTime}
                      />
                    )}
                  </div>
                )}

                {openClue.revealed && (
                  <>
                    <div className="pv-clue-answer">{openClue.answer || "(no answer set)"}</div>
                    {answerMediaUrl && answerRenderAs && (
                      <div className="pv-clue-media pv-clue-answer-media">
                        {answerRenderAs === "image" && (
                          <img src={answerMediaUrl} alt="" onError={() => setAnswerRenderAs("video")} />
                        )}
                        {answerRenderAs === "video" &&
                          (youTubeEmbed(answerMediaUrl) ? (
                            <iframe
                              src={youTubeEmbed(answerMediaUrl)}
                              allow="autoplay; encrypted-media; picture-in-picture"
                              allowFullScreen
                              title="clue-answer-video"
                            />
                          ) : (
                            <CustomVideoPlayer 
                              src={answerMediaUrl} 
                              onError={() => setAnswerRenderAs("audio")} 
                              disablePlayPause={true}
                              disableSeeking={true}
                              isPlaying={openClue.isPlaying}
                              currentTime={openClue.currentTime}
                            />
                          ))}
                        {answerRenderAs === "audio" && (
                          <CustomAudioPlayer 
                            src={answerMediaUrl} 
                            disablePlayPause={true}
                            disableSeeking={true}
                            isPlaying={openClue.isPlaying}
                            currentTime={openClue.currentTime}
                          />
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="pv-clue-scoreboard">
            <BuzzStatusText
              buzzerLive={buzzerLive}
              iHaveFloor={iHaveFloor}
              alreadyBuzzed={alreadyBuzzed}
              myPosition={myPosition}
              className="pv-buzzer-status-compact"
            />
            <button
              className={"pv-buzz-btn pv-buzz-btn-side" + (buzzDisabled ? " pv-buzz-disabled" : "")}
              disabled={buzzDisabled}
              onClick={buzz}
            >
              BUZZ
            </button>
            <div className="pv-scoreboard-title">SCOREBOARD</div>
            <TeamScoreRow teams={boardData.teams} joinedTeamId={joinedTeam?.teamId} pulseMap={pulseMap} discordMembersByTeam={discordMembersByTeam} buzzStateByTeam={buzzStateByTeam} compact />
          </div>
        </div>
      )}

      <div className="pv-board">
        {rd.categories.map((cat, catIndex) => {
          const isRevealed = revealedCats.includes(cat.id);
          return (
            <div
              key={cat.id}
              className={
                "pv-cat" +
                (isRevealed ? "" : " pv-cat-locked") +
                (boardFlip === "out" ? " flip-out" : "") +
                (boardFlip === "in-start" ? " flip-in-start" : "")
              }
              style={{ transitionDelay: flipDelay(catIndex) }}
            >
              <div className={"pv-cat-name" + (isRevealed ? " cat-name-reveal" : "")}>
                {isRevealed ? cat.name || "—" : <span className="pv-cat-mark">?</span>}
              </div>
              <div className="pv-cells">
                {rd.values.map((v) => {
                  const clue = cat.clues?.[v];
                  const pickable = !clue?.used && isMyTurn;
                  return (
                    <div
                      key={v}
                      className={"pv-cell" + (clue?.used ? " pv-used" : "") + (pickable ? " pv-pickable" : "")}
                      role={pickable ? "button" : undefined}
                      onClick={() => {
                        // Client-side gating is just for UX (cursor/dim
                        // state) — the server re-validates against
                        // controlDiscordUserId regardless, so this can't be
                        // bypassed by forcing the click through.
                        if (!pickable) return;
                        selectClue({ catId: cat.id, value: v });
                      }}
                    >
                      {clue?.used ? "" : `$${v}`}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {!openClue && (
        <TeamScoreRow teams={boardData.teams} joinedTeamId={joinedTeam?.teamId} pulseMap={pulseMap} discordMembersByTeam={discordMembersByTeam} buzzStateByTeam={buzzStateByTeam} />
      )}

      <PlayerBgmWidget roomCode={roomCode} bgm={bgm} />
    </div>
  );
}