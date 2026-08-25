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

export default function App() {
  // 1. ALL HOOKS MUST BE AT THE VERY TOP (Never conditional or after an early return)
  const [currentPath, setCurrentPath] = useState(window.location.pathname);
  const [hostMode, setHostMode] = useState(false);

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
        <JeopardyBoard onBack={() => setHostMode(false)} />
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
    window.history.pushState({}, '', `/play?room=${code}`);
    setCurrentPath(`/play?room=${code}`);
  };

  return (
    <RoleSelect
      onSelectHost={() => setHostMode(true)}
      onSelectPlayer={handleSelectPlayer}
      isJoining={joining}
    />
  );
}