import React, { useState, useEffect } from 'react';
import JeopardyBoard from './JeopardyBoard';
import LoginGate from "./components/LoginGate";
import PlayerView from "./components/PlayerView";
import RoleSelect from "./components/RoleSelect";
import { SocketProvider } from "./lib/SocketContext";
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

function buildPlayPath(roomCode) {
  const params = new URLSearchParams(window.location.search);
  params.set("room", roomCode);
  return `/play?${params.toString()}`;
}

export default function App() {
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

  useEffect(() => installGlobalBoardSfx(), []);

  // 2. CONDITIONAL RETURNS
  if (currentPath.startsWith("/play")) {
    return (
      <SocketProvider>
        <PlayerView />
      </SocketProvider>
    );
  }

  if (hostMode) {
    return (
      <SocketProvider>
        <LoginGate>
          <JeopardyBoard
            onBack={() => {
              sessionStorage.removeItem(ACTIVE_HOST_MODE_KEY);
              setHostMode(false);
            }}
          />
        </LoginGate>
      </SocketProvider>
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