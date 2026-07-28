import React, { useState, useEffect } from 'react';
import JeopardyBoard from './JeopardyBoard';
import LoginGate from "./components/LoginGate";
import PlayerView from "./components/PlayerView";
import { getDiscordIdentity } from './discordSdk';
import '@fontsource/quicksand/300.css';
import '@fontsource/quicksand/700.css';
import '@fontsource/comfortaa/700.css';
import "./styles/player.css";

export default function App() {
  // 1. ALL HOOKS MUST BE AT THE VERY TOP (Never conditional or after an early return)
  const [currentPath, setCurrentPath] = useState(window.location.pathname);
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [hostMode, setHostMode] = useState(false);

  const [joining, setJoining] = useState(false);

  useEffect(() => {
    const handlePopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

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
  const handleJoinClick = async () => {
    const code = roomCodeInput.trim().toUpperCase();
    const name = nameInput.trim();
    if (!code || !name) return;

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

  const canJoin = roomCodeInput.trim() && nameInput.trim() && !joining;

  return (
    <div className="pv-root pv-center app-landing-root">
      <div className="pv-join-card app-landing-card">
        <h1 className="app-landing-title">JEOPARDY!</h1>
        <p className="app-landing-subtitle">Discord Activity Game Show</p>

        <button
          onClick={() => setHostMode(true)}
          className="pv-btn pv-btn-primary app-host-btn"
        >
          Host / Manage Board
        </button>

        <div className="app-divider">
          <div className="app-divider-line" />
          <span>OR</span>
          <div className="app-divider-line" />
        </div>

        <div className="app-join-section">
          <label className="app-join-label">
            Room Code
            <input
              type="text"
              placeholder="e.g. 7FE4SE"
              value={roomCodeInput}
              onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
              maxLength={8}
              className="app-room-input"
            />
          </label>

          <label className="app-join-label">
            Your Name
            <input
              type="text"
              placeholder="How you'll appear on the buzzer"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              maxLength={24}
              className="app-room-input"
              style={{ textAlign: 'left', textTransform: 'none', letterSpacing: 'normal' }}
            />
          </label>

          <button
            type="button"
            onClick={handleJoinClick}
            disabled={!canJoin}
            className="pv-btn pv-btn-primary app-join-btn"
            style={{ opacity: canJoin ? 1 : 0.5, cursor: canJoin ? 'pointer' : 'not-allowed', marginTop: '0.5rem' }}
          >
            {joining ? 'Joining…' : 'Join Game'}
          </button>
        </div>
      </div>
    </div>
  );
}