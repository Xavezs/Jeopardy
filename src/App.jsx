import React, { useState, useEffect } from 'react';
import JeopardyBoard from './JeopardyBoard';
import LoginGate from "./components/LoginGate";
import PlayerView from "./components/PlayerView";
import RoleSelect from "./components/RoleSelect";
import { getDiscordIdentity } from './discordSdk';
import { installGlobalBoardSfx } from './lib/boardSfx';
import '@fontsource/quicksand/300.css';
import '@fontsource/quicksand/600.css';
import '@fontsource/quicksand/700.css';
import '@fontsource/comfortaa/700.css';
import "./styles/player.css";

const ACTIVE_PLAYER_ROOM_KEY = "jeopardy:active-player-room";
const ACTIVE_PLAYER_ROOM_SAVED_AT_KEY = "jeopardy:active-player-room-saved-at";
const ACTIVE_PLAYER_ROOM_MAX_AGE_MS = 30 * 60 * 1000;
const ACTIVE_HOST_MODE_KEY = "jeopardy:active-host-mode";

// Discord launches the Activity with `frame_id` (and `channel_id`,
// `instance_id`) in the URL query string — discordSdk.js reads `frame_id`
// at MODULE LOAD TIME to decide whether it's safe to construct a real
// DiscordSDK instance at all (`hasFrameId`). Building the /play URL with a
// plain template literal like `/play?room=${code}` REPLACES the entire
// query string, silently dropping frame_id along with it.
//
// This is harmless as long as the page never does a full reload after
// that point — hasFrameId was already computed once, before the
// pushState/replaceState ran. But the moment anything forces a real
// reload afterward (a failed HMR update falling back to a full refresh, a
// manual browser refresh, Discord itself reloading the iframe, etc.), the
// browser re-parses whatever URL is CURRENTLY in the address bar — which
// by then has no frame_id — and hasFrameId permanently evaluates to
// false. From that point on, getDiscordIdentity() is skipped entirely for
// every player, with no visible error: buzzing still works (it never
// needed Discord identity), but avatars and buzz-queue team attribution
// silently break for everyone, and no further reload can fix it — only
// closing and relaunching the Activity fresh from Discord restores
// frame_id. Preserving the existing query string when building /play URLs
// avoids ever entering that state.
function buildPlayPath(roomCode) {
  const params = new URLSearchParams(window.location.search);
  params.set("room", roomCode);
  return `/play?${params.toString()}`;
}

export default function App() {
  // 1. ALL HOOKS MUST BE AT THE VERY TOP (Never conditional or after an early return)
  const [currentPath, setCurrentPath] = useState(() => {
    if (window.location.pathname.startsWith("/play")) return window.location.pathname;
    const savedRoom = sessionStorage.getItem(ACTIVE_PLAYER_ROOM_KEY);
    const savedAt = Number(sessionStorage.getItem(ACTIVE_PLAYER_ROOM_SAVED_AT_KEY));
    const isRecent = Number.isFinite(savedAt) && Date.now() - savedAt <= ACTIVE_PLAYER_ROOM_MAX_AGE_MS;
    if (!savedRoom || !isRecent) {
      sessionStorage.removeItem(ACTIVE_PLAYER_ROOM_KEY);
      sessionStorage.removeItem(ACTIVE_PLAYER_ROOM_SAVED_AT_KEY);
      return window.location.pathname;
    }
    const restoredPath = buildPlayPath(savedRoom);
    window.history.replaceState({}, "", restoredPath);
    return restoredPath;
  });
  const [hostMode, setHostMode] = useState(() => sessionStorage.getItem(ACTIVE_HOST_MODE_KEY) === "1");

  const [joining, setJoining] = useState(false);

  useEffect(() => {
    const handlePopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Click/hover sfx for every button in the app, wired up once here since
  // App is the one component that's always mounted regardless of route or
  // auth status — covers RoleSelect and LoginGate's loading/error screens
  // too, not just once PlayerView/JeopardyBoard get to render.
  useEffect(() => installGlobalBoardSfx(), []);

  // 2. CONDITIONAL RETURNS (Safe now because hooks have already run)
  if (currentPath.startsWith("/play")) {
    return <PlayerView />;
  }

  if (hostMode) {
    return (
      <LoginGate>
        <JeopardyBoard
          onBack={() => {
            sessionStorage.removeItem(ACTIVE_HOST_MODE_KEY);
            setHostMode(false);
          }}
        />
      </LoginGate>
    );
  }

  // 3. EVENT HANDLERS
  const handleSelectPlayer = async (code, name) => {
    let id = localStorage.getItem(`jeopardy:player:${code}:id`);
    if (!id) {
      id = 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(`jeopardy:player:${code}:id`, id);
    }
    localStorage.setItem(`jeopardy:player:${code}:name`, name);

    // Resolve Discord identity if we're actually running inside the
    // Activity iframe — returns null harmlessly in standalone/dev mode,
    // same as setupDiscordSdk already does elsewhere.
    //
    // IMPORTANT: use getDiscordIdentity() here, not setupDiscordSdk() +
    // authenticateDiscordUser() directly. Those two calling this page ever
    // used to bypass discordSdk.js's page-lifetime identityPromise cache
    // entirely, so PlayerView.jsx's later call (right after this one
    // navigates to /play) was treated as a completely separate, uncached
    // authorize() — that's what caused the double consent popup on every
    // join. getDiscordIdentity() is shared and cached across every caller
    // on this page load, so this now runs the whole authorize/authenticate
    // flow exactly once, however many components ask for identity.
    setJoining(true);
    try {
      const discordUser = await getDiscordIdentity();
      if (discordUser) {
        localStorage.setItem(`jeopardy:player:${code}:discordUser`, JSON.stringify(discordUser));
      } else {
        localStorage.removeItem(`jeopardy:player:${code}:discordUser`);
      }
    } catch (err) {
      console.warn('Discord identity resolution failed, continuing without it:', err.message);
      localStorage.removeItem(`jeopardy:player:${code}:discordUser`);
    } finally {
      setJoining(false);
    }

    // Soft navigate to /play without a hard reload
    window.history.pushState({}, '', buildPlayPath(code));
    sessionStorage.setItem(ACTIVE_PLAYER_ROOM_KEY, code);
    sessionStorage.setItem(ACTIVE_PLAYER_ROOM_SAVED_AT_KEY, String(Date.now()));
    setCurrentPath(`/play?room=${code}`);
  };

  return (
    <RoleSelect
      onSelectHost={() => {
        sessionStorage.setItem(ACTIVE_HOST_MODE_KEY, "1");
        setHostMode(true);
      }}
      onSelectPlayer={handleSelectPlayer}
      isJoining={joining}
    />
  );
}