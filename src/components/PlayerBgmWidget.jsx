import React, { useState, useEffect, useRef } from "react";
import { getMediaUrl } from "../lib/storage";

/* =========================================================================
   PLAYER BGM WIDGET
   Read-only mirror of the host's BackgroundMusicPlayer — a player can't
   start/stop/skip the track (that's the host's call, synced via
   useBgmSync -> usePlayerSync's `bgm`), but they DO get their own
   independent volume, stored locally (per room) and never sent anywhere.

   Position sync: `bgm.positionSeconds` + `bgm.updatedAt` (a server-clock
   timestamp) let us compute where the track should actually be right now
   — positionSeconds, plus elapsed wall-clock time since updatedAt if
   still playing — without needing a continuous position stream. We only
   nudge currentTime when drift exceeds DRIFT_TOLERANCE_S, so small clock
   differences between client/server don't cause constant choppy seeking.

   Browser autoplay policies block audio.play() until the page has seen a
   user gesture. Since playback here is triggered by an incoming socket
   event rather than a click, the first attempt after a fresh page load
   commonly gets rejected — needsGesture surfaces a one-tap "Enable sound"
   prompt for that case rather than silently failing forever.
   ========================================================================= */
const DRIFT_TOLERANCE_S = 1.5;

function volumeKey(roomCode) {
  return `jeopardy:player:${roomCode || "_"}:bgmVolume`;
}

export default function PlayerBgmWidget({ roomCode, bgm }) {
  const [open, setOpen] = useState(false);
  const [mediaUrl, setMediaUrl] = useState("");
  const [needsGesture, setNeedsGesture] = useState(false);
  const [volume, setVolume] = useState(() => {
    const saved = parseFloat(localStorage.getItem(volumeKey(roomCode)));
    return Number.isFinite(saved) ? Math.max(0, Math.min(1, saved)) : 0.5;
  });
  const audioRef = useRef(null);

  // Resolve the current track's fileRef into a playable URL. Supabase
  // public URLs work cross-client (unlike the old IndexedDB-only
  // approach), so this is the same file the host loaded, not a copy.
  useEffect(() => {
    let cancelled = false;
    async function resolve() {
      if (!bgm?.fileRef) {
        setMediaUrl("");
        return;
      }
      const url = await getMediaUrl(bgm.fileRef);
      if (!cancelled) setMediaUrl(url);
    }
    resolve();
    return () => {
      cancelled = true;
    };
  }, [bgm?.fileRef]);

  // Keep this player's own volume local-only — saved per room so it
  // survives a reload, but never sent to the server or anyone else.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    try {
      localStorage.setItem(volumeKey(roomCode), String(volume));
    } catch {
      /* private-browsing localStorage can throw — losing the saved
         preference isn't worth surfacing an error for */
    }
  }, [volume, roomCode]);

  // Mirror the host's play/pause + position whenever bgm state changes.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !mediaUrl || !bgm) return;

    const elapsed = bgm.playing ? Math.max(0, (Date.now() - (bgm.updatedAt || Date.now())) / 1000) : 0;
    const target = Math.max(0, (bgm.positionSeconds || 0) + elapsed);
    if (Math.abs(audio.currentTime - target) > DRIFT_TOLERANCE_S) {
      audio.currentTime = target;
    }

    if (bgm.playing) {
      audio
        .play()
        .then(() => setNeedsGesture(false))
        .catch(() => setNeedsGesture(true));
    } else {
      audio.pause();
    }
  }, [bgm, mediaUrl]);

  function handleEnableSound() {
    const audio = audioRef.current;
    if (!audio) return;
    audio
      .play()
      .then(() => setNeedsGesture(false))
      .catch(() => setNeedsGesture(true));
  }

  if (!bgm?.fileRef) return null;

  return (
    <div className="pv-bgm-widget">
      {open && (
        <div className="pv-bgm-panel">
          <div className="pv-bgm-track-name" title={bgm.fileName}>
            {bgm.fileName || "Background music"}
          </div>

          {needsGesture && (
            <button type="button" className="pv-bgm-enable-btn" onClick={handleEnableSound}>
              🔈 Tap to enable sound
            </button>
          )}

          <div className="pv-bgm-volume-row">
            <span className="pv-bgm-volume-icon">{volume === 0 ? "🔇" : "🔊"}</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              title="Your volume (only affects your own device)"
            />
          </div>
        </div>
      )}

      <button
        type="button"
        className={"pv-bgm-toggle-btn" + (bgm.playing ? " is-playing" : "")}
        onClick={() => setOpen((v) => !v)}
        title="Background music"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      </button>

      {mediaUrl && <audio ref={audioRef} src={mediaUrl} loop={bgm.loop} />}
    </div>
  );
}
