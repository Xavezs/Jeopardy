import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { getMediaUrl } from "../lib/storage";
import {
  subscribeSfxDucking,
  loadFinalStandingsVolume,
  setFinalStandingsVolume,
  getFinalStandingsVolume,
} from "../lib/boardSfx";

// PLAYER BGM WIDGET
const DRIFT_TOLERANCE_S = 1.5;
// Master ceiling for the BGM source itself
const MASTER_BGM_GAIN = 0.6;
const DUCK_LEVEL = 0;
const DUCK_FADE_MS = 700;
const FADE_IN_MS = 900;
const ROUND_FADE_OUT_MS = 500;

function calcGain(sliderVolume) {
  return sliderVolume * sliderVolume * MASTER_BGM_GAIN;
}

// Applies ducking on top of calcGain's taper
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
  const [ducking, setDucking] = useState(false);
  useEffect(() => subscribeSfxDucking(setDucking), []);
  const [volume, setVolume] = useState(() => {
    const saved = parseFloat(localStorage.getItem(volumeKey(roomCode)));
    return Number.isFinite(saved) ? Math.max(0, Math.min(1, saved)) : 0.15;
  });
  // Celebration-sound volume
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
  const duckingRef = useRef(ducking);
  const volumeRef = useRef(volume);
  useEffect(() => {
    duckingRef.current = ducking;
    volumeRef.current = volume;
  });
  const forceFadeInRef = useRef(false);

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

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      if (!bgm?.fileRef) {
        setMediaUrl("");
        return;
      }
      const url = await getMediaUrl(bgm.fileRef);
      if (cancelled) return;
      forceFadeInRef.current = true;
      setMediaUrl(url);
    }

    async function run() {
      const audio = audioRef.current;
      if (prevPlayingRef.current && audio && !audio.paused) {
        await new Promise((res) => {
          fadeVolumeTo(0, ROUND_FADE_OUT_MS);
          setTimeout(res, ROUND_FADE_OUT_MS);
        });
        if (cancelled) return;
      }
      await resolve();
    }
    run();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgm?.fileRef]);

  // Keep this player's own volume local-only
  useEffect(() => {
    cancelFade();
    if (audioRef.current) audioRef.current.volume = calcDuckedGain(volume, ducking);
    try {
      localStorage.setItem(volumeKey(roomCode), String(volume));
    } catch {
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, roomCode]);

  useEffect(() => {
    if (!audioRef.current) return;
    fadeVolumeTo(calcDuckedGain(volume, ducking), DUCK_FADE_MS);
    return cancelFade;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ducking]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !mediaUrl || !bgm) return;

    const elapsed = bgm.playing ? Math.max(0, (Date.now() - (bgm.updatedAt || Date.now())) / 1000) : 0;
    const target = Math.max(0, (bgm.positionSeconds || 0) + elapsed);
    if (Math.abs(audio.currentTime - target) > DRIFT_TOLERANCE_S) {
      audio.currentTime = target;
    }

    if (bgm.playing) {
      const startingPlayback = !prevPlayingRef.current || forceFadeInRef.current;
      if (startingPlayback) audio.volume = 0;
      audio
        .play()
        .then(() => {
          setNeedsGesture(false);
          if (startingPlayback) {
            forceFadeInRef.current = false;
            fadeVolumeTo(calcDuckedGain(volumeRef.current, duckingRef.current));
          }
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
        fadeVolumeTo(calcDuckedGain(volumeRef.current, duckingRef.current));
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