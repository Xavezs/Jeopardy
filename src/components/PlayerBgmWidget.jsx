import React, { useState, useEffect, useRef } from "react";
import { getMediaUrl } from "../lib/storage";

/* =========================================================================
   PLAYER BGM WIDGET
   Read-only mirror of the host's BackgroundMusicPlayer — a player can't
   start/stop/skip the track (that's the host's call, synced via
   useBgmSync -> usePlayerSync's `bgm`), but they DO get their own
   independent volume, stored locally (per room) and never sent anywhere.

   Track source: a plain <audio> element playing whatever the host has
   loaded (uploaded file or direct audio URL).

   NOTE: SoundCloud mirroring was removed — see lib/soundcloud.js and
   BackgroundMusicPlayer.jsx for why. If `bgm.source` is still
   "soundcloud" from data saved before this change, it's just treated as
   no track (falls back to bgm.fileRef, which will be empty).

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
// Master ceiling for the BGM source itself — even at slider max, actual
// gain never exceeds this. Lower this if the track is just too loud
// overall regardless of anyone's individual slider setting.
const MASTER_BGM_GAIN = 0.6;
// How long the fade-in takes whenever playback actually starts (player
// just joined mid-song, or the host just hit play). Without this, the
// track snaps straight to full gain the instant it starts, which reads
// as a sudden loud "jolt" even when the steady-state volume is fine.
const FADE_IN_MS = 900;

function calcGain(sliderVolume) {
  return sliderVolume * sliderVolume * MASTER_BGM_GAIN;
}

function volumeKey(roomCode) {
  return `jeopardy:player:${roomCode || "_"}:bgmVolume`;
}

export default function PlayerBgmWidget({ roomCode, bgm }) {
  const [open, setOpen] = useState(false);
  const [mediaUrl, setMediaUrl] = useState("");
  const [needsGesture, setNeedsGesture] = useState(false);
  const [volume, setVolume] = useState(() => {
    const saved = parseFloat(localStorage.getItem(volumeKey(roomCode)));
    return Number.isFinite(saved) ? Math.max(0, Math.min(1, saved)) : 0.15;
  });
  const audioRef = useRef(null);
  const fadeRafRef = useRef(null);
  const prevPlayingRef = useRef(false);

  function cancelFade() {
    if (fadeRafRef.current != null) {
      cancelAnimationFrame(fadeRafRef.current);
      fadeRafRef.current = null;
    }
  }

  function fadeVolumeTo(target, duration = FADE_IN_MS) {
    const audio = audioRef.current;
    if (!audio) return;
    cancelFade();
    const from = audio.volume;
    const clampedTarget = Math.max(0, Math.min(1, target));
    if (Math.abs(from - clampedTarget) < 0.004) {
      audio.volume = clampedTarget;
      return;
    }
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      audio.volume = from + (clampedTarget - from) * eased;
      if (t < 1) {
        fadeRafRef.current = requestAnimationFrame(step);
      } else {
        fadeRafRef.current = null;
      }
    }
    fadeRafRef.current = requestAnimationFrame(step);
  }

  useEffect(() => cancelFade, []);

  // Resolve the current track's fileRef into a playable URL.
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
  //
  // Human hearing perceives loudness roughly logarithmically, while
  // <audio>.volume is linear — so a raw slider value of e.g. 0.3 sounds
  // much louder than "30% as loud" would suggest. Squaring the slider
  // value before assigning it as gain (a common taper approximation)
  // makes the low end of the slider actually feel quiet.
  useEffect(() => {
    cancelFade();
    if (audioRef.current) audioRef.current.volume = calcGain(volume);
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
      const startingPlayback = !prevPlayingRef.current;
      if (startingPlayback) audio.volume = 0;
      audio
        .play()
        .then(() => {
          setNeedsGesture(false);
          if (startingPlayback) fadeVolumeTo(calcGain(volume));
        })
        .catch(() => setNeedsGesture(true));
    } else {
      cancelFade();
      audio.pause();
    }
    prevPlayingRef.current = bgm.playing;
  }, [bgm, mediaUrl]);

  function handleEnableSound() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = 0;
    audio
      .play()
      .then(() => {
        setNeedsGesture(false);
        fadeVolumeTo(calcGain(volume));
      })
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
            <span className="pv-bgm-volume-icon" aria-hidden="true">
              {volume === 0 ? (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 5 6 9H2v6h4l5 4V5Z" />
                  <path d="m17 9 6 6M23 9l-6 6" />
                </svg>
              ) : volume < 0.5 ? (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 5 6 9H2v6h4l5 4V5Z" />
                  <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 5 6 9H2v6h4l5 4V5Z" />
                  <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                  <path d="M18.5 5.5a9 9 0 0 1 0 13" />
                </svg>
              )}
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              style={{ "--pv-vol": Math.round(volume * 100) }}
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