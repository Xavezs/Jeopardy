import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { getMediaUrl } from "../lib/storage";
import {
  subscribeSfxDucking,
  loadFinalStandingsVolume,
  setFinalStandingsVolume,
  getFinalStandingsVolume,
} from "../lib/boardSfx";

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

   Final Standings celebration sound volume: same "local, per-device,
   never synced" pattern as the BGM volume above, just backed by
   boardSfx.js's own storage key (jp_final_standings_volume) instead of
   this file's own localStorage key. playStandingsCelebration() is
   triggered independently on every client (host + each player), and
   each one reads finalStandingsVolume from boardSfx.js's local module
   state at play time — so hydrating/setting it here is enough to control
   this player's own copy of the celebration sound, with no server
   round-trip needed.

   Position sync: `bgm.positionSeconds` + `bgm.updatedAt` (a server-clock
   timestamp) let us compute where the track should actually be right now
   — positionSeconds, plus elapsed wall-clock time since updatedAt if
   still playing — without needing a continuous position stream. We only
   nudge currentTime when drift exceeds DRIFT_TOLERANCE_S, so small clock
   differences between client/server don't cause constant choppy seeking.

   Rendering: this widget is `position: fixed`, but PlayerView's root
   (.pv-root) sets `overflow-x: hidden`, which per spec forces
   overflow-y to a non-visible value too — and a non-visible overflow
   ancestor clips ALL descendants during paint, including fixed-position
   ones, regardless of their actual containing block. Left alone, that
   clips this widget to .pv-root's box instead of floating freely over
   the whole viewport like the host's BackgroundMusicPlayer does.
   Portalling straight to document.body sidesteps that entirely — same
   fix pattern as any fixed-position overlay nested inside a clipped
   ancestor.

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
// How much quieter the track gets while ducked (Final Standings'
// celebration sound, etc. — see subscribeSfxDucking below). Keep in sync
// with BackgroundMusicPlayer.jsx's DUCK_LEVEL so host and players duck
// by the same proportion.
const DUCK_LEVEL = 0.15;
const DUCK_FADE_MS = 700;
// How long the fade-in takes whenever playback actually starts (player
// just joined mid-song, or the host just hit play). Without this, the
// track snaps straight to full gain the instant it starts, which reads
// as a sudden loud "jolt" even when the steady-state volume is fine.
const FADE_IN_MS = 900;

function calcGain(sliderVolume) {
  return sliderVolume * sliderVolume * MASTER_BGM_GAIN;
}

// Applies ducking on top of calcGain's taper — same combination
// BackgroundMusicPlayer.jsx uses, just factored out here since this file
// needs it at more call sites (drift-correction re-sync, fade targets,
// and the ducking toggle itself).
function calcDuckedGain(sliderVolume, ducking) {
  return calcGain(ducking ? sliderVolume * DUCK_LEVEL : sliderVolume);
}

function volumeKey(roomCode) {
  return `jeopardy:player:${roomCode || "_"}:bgmVolume`;
}

export default function PlayerBgmWidget({ roomCode, bgm }) {
  const [open, setOpen] = useState(false);
  const [mediaUrl, setMediaUrl] = useState("");
  const [needsGesture, setNeedsGesture] = useState(false);
  // Ducked while boardSfx.js's ducking bus is active (currently just
  // Final Standings' celebration sound) — separate from the host's own
  // ducking, since that only affects the host's copy of the BGM audio.
  // Each player's client plays its own independent BGM audio element, so
  // each one needs to duck itself in response to the same bus.
  const [ducking, setDucking] = useState(false);
  useEffect(() => subscribeSfxDucking(setDucking), []);
  const [volume, setVolume] = useState(() => {
    const saved = parseFloat(localStorage.getItem(volumeKey(roomCode)));
    return Number.isFinite(saved) ? Math.max(0, Math.min(1, saved)) : 0.15;
  });
  // Celebration-sound volume — starts from boardSfx.js's in-memory
  // default and gets hydrated from storage on mount, same as
  // JeopardyBoard does on the host side.
  const [fsVolume, setFsVolume] = useState(getFinalStandingsVolume());
  useEffect(() => {
    let cancelled = false;
    loadFinalStandingsVolume().then((v) => {
      if (!cancelled) setFsVolume(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  function handleFsVolumeChange(v) {
    setFsVolume(v);
    setFinalStandingsVolume(v);
  }
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
    if (audioRef.current) audioRef.current.volume = calcDuckedGain(volume, ducking);
    try {
      localStorage.setItem(volumeKey(roomCode), String(volume));
    } catch {
      /* private-browsing localStorage can throw — losing the saved
         preference isn't worth surfacing an error for */
    }
    // `ducking` is deliberately excluded below: it's still read inside
    // this effect (so a manual volume-slider drag while ducked respects
    // the ducked level), but ducking *transitions* are handled by the
    // dedicated fade effect right after this one. If both effects reacted
    // to `ducking`, this one's instant snap would win the race and
    // cancel out the other's fade.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, roomCode]);

  // Smoothly fade in/out when ducking toggles, rather than snapping —
  // mirrors BackgroundMusicPlayer.jsx's identical effect on the host
  // side, just reading `ducking` from the bus instead of a prop.
  useEffect(() => {
    if (!audioRef.current) return;
    fadeVolumeTo(calcDuckedGain(volume, ducking), DUCK_FADE_MS);
    return cancelFade;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ducking]);

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
          if (startingPlayback) fadeVolumeTo(calcDuckedGain(volume, ducking));
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
        fadeVolumeTo(calcDuckedGain(volume, ducking));
      })
      .catch(() => setNeedsGesture(true));
  }

  const hasTrack = !!bgm?.fileRef;

  return createPortal(
    <div className="pv-bgm-widget">
      {open && (
        <div className="pv-bgm-panel">
          <div className="pv-bgm-panel-title">Background Music</div>

          <div className="pv-bgm-track-name" title={hasTrack ? bgm.fileName : undefined}>
            {hasTrack ? bgm.fileName || "Background music" : "No background music"}
          </div>

          {hasTrack && needsGesture && (
            <button type="button" className="pv-bgm-enable-btn" onClick={handleEnableSound}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 5 6 9H2v6h4l5 4V5Z" />
                <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                <path d="M18.5 5.5a9 9 0 0 1 0 13" />
              </svg>
              Tap to enable sound
            </button>
          )}

          {hasTrack && (
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
                title="Your volume (only affects your own device)"
              />
            </div>
          )}

          <div className="pv-bgm-fs-volume-row">
            <span className="pv-bgm-fs-volume-label" title="Volume for the Final Standings celebration sound — only affects your own device">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 21h8" />
                <path d="M12 17v4" />
                <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" />
                <path d="M7 5H4a2 2 0 0 0 2 3.5" />
                <path d="M17 5h3a2 2 0 0 1-2 3.5" />
              </svg>
              Final Standings
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={fsVolume}
              onChange={(e) => handleFsVolumeChange(parseFloat(e.target.value))}
              title="Your celebration sound volume (only affects your own device)"
            />
          </div>
        </div>
      )}

      <button
        type="button"
        className={"pv-bgm-toggle-btn" + (bgm?.playing ? " is-playing" : "")}
        onClick={() => setOpen((v) => !v)}
        title="Background music"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      </button>

      {mediaUrl && <audio ref={audioRef} src={mediaUrl} loop={bgm?.loop} />}
    </div>,
    document.body
  );
}