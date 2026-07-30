import React, { useState, useEffect, useRef } from "react";
import { getMediaUrl } from "../lib/storage";

/* =========================================================================
   BACKGROUND MUSIC PLAYER
   A small floating widget (bottom-right corner) that stays out of the way
   of the board. Collapsed, it's just a round note button; clicking it
   opens a compact panel with upload / play / volume / loop controls.
   The track itself is stored via MediaStore (same IndexedDB-backed store
   clue media already uses) so it persists with the session — only the
   fileRef string lives in session settings, not the audio data itself.
   ========================================================================= */
// How far background music ducks down while clue audio/video plays (as a
// fraction of the user's chosen volume), and how long the fade takes.
const DUCK_LEVEL = 0.15;
const DUCK_FADE_MS = 700;

export default function BackgroundMusicPlayer({
  settings,
  onUploadFile,
  onUrlChange,
  onClear,
  onVolumeChange,
  onToggleLoop,
  ducking = false,
  // Called with { fileRef, fileName, loop, playing, positionSeconds,
  // updatedAt } whenever any of those change — lets JeopardyBoard
  // broadcast "now playing" state to players via useBgmSync. Deliberately
  // excludes volume: each client's volume is local-only, never synced.
  onPlaybackChange,
}) {
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false); // never persisted — browsers block autoplay anyway, so this always starts paused on load
  const [mediaUrl, setMediaUrl] = useState("");
  const [urlMode, setUrlMode] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const audioRef = useRef(null);
  const fadeRafRef = useRef(null);

  function cancelFade() {
    if (fadeRafRef.current != null) {
      cancelAnimationFrame(fadeRafRef.current);
      fadeRafRef.current = null;
    }
  }

  // Smoothly ramps the <audio> element's actual volume to `target` over
  // `duration` ms (ease-in-out), rather than snapping — this is what makes
  // ducking for clue media feel like a fade instead of a jump cut.
  function fadeVolumeTo(target, duration = DUCK_FADE_MS) {
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
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease-in-out-quad
      audio.volume = from + (clampedTarget - from) * eased;
      if (t < 1) {
        fadeRafRef.current = requestAnimationFrame(step);
      } else {
        fadeRafRef.current = null;
      }
    }
    fadeRafRef.current = requestAnimationFrame(step);
  }

  // Resolve the stored fileRef to a playable URL whenever the track changes.
  useEffect(() => {
    let cancelled = false;
    let urlToRevoke = "";

    async function resolve() {
      if (!settings.fileRef) {
        setMediaUrl("");
        return;
      }
      const url = await getMediaUrl(settings.fileRef);
      if (cancelled) {
        if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
        return;
      }
      urlToRevoke = url && url.startsWith("blob:") ? url : "";
      setMediaUrl(url);
    }
    setPlaying(false);
    resolve();

    return () => {
      cancelled = true;
      if (urlToRevoke) URL.revokeObjectURL(urlToRevoke);
    };
  }, [settings.fileRef]);

  // Keep the <audio> element's volume/loop in sync with settings.
  // mediaUrl is included here too — the <audio> element only exists once a
  // track is loaded, so when it first mounts (or remounts for a new track)
  // these need to be (re)applied to that fresh DOM node, not just whenever
  // the settings values themselves change.
  // This effect applies volume changes (slider moves, track loads)
  // INSTANTLY — it deliberately does not depend on `ducking`. The actual
  // duck/un-duck transition is its own smooth fade, handled below.
  useEffect(() => {
    if (audioRef.current) {
      cancelFade();
      audioRef.current.volume = ducking ? settings.volume * DUCK_LEVEL : settings.volume;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.volume, mediaUrl]);
  useEffect(() => {
    if (audioRef.current) audioRef.current.loop = settings.loop;
  }, [settings.loop, mediaUrl]);

  // Whenever a clue's audio/video starts or stops playing, fade background
  // music down to DUCK_LEVEL (or back up to the full setting) instead of
  // snapping — so the two never abruptly cut over each other.
  useEffect(() => {
    if (!audioRef.current) return;
    fadeVolumeTo(ducking ? settings.volume * DUCK_LEVEL : settings.volume);
    return cancelFade;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ducking]);

  // Clean up any in-flight fade on unmount.
  useEffect(() => cancelFade, []);

  // Report "now playing" state up to the parent whenever it actually
  // changes — play/pause toggling, track swap, or loop toggle. This is
  // the single source JeopardyBoard uses to broadcast bgmUpdate to
  // players, so it needs to fire on every state change, not just clicks:
  // it also covers the audio naturally ending (see onEnded below) and a
  // fresh track load resetting `playing` back to false.
  useEffect(() => {
    if (!onPlaybackChange) return;
    onPlaybackChange({
      fileRef: settings.fileRef || "",
      fileName: settings.fileName || "",
      loop: !!settings.loop,
      playing,
      positionSeconds: audioRef.current ? audioRef.current.currentTime : 0,
      updatedAt: Date.now(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, settings.fileRef, settings.loop]);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio || !mediaUrl) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  }

  function handleFileChange(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow picking the same file again later
    if (file) onUploadFile(file);
  }

  // Direct audio link (mp3/ogg/etc — not YouTube/Spotify, those need a
  // real embedded player which Discord's Activity CSP blocks). getMediaUrl
  // already knows how to route a plain http(s) URL through our own
  // server's /api/media/proxy route, same as clue media, so this just
  // needs to hand the raw URL to the parent as the new fileRef — no
  // upload step, no MediaStore involved.
  function handleUrlSubmit() {
    const trimmed = urlInput.trim();
    if (!trimmed || !/^https?:\/\//i.test(trimmed)) return;
    const name = trimmed.split("/").pop().split(/[?#]/)[0] || "External track";
    onUrlChange(trimmed, decodeURIComponent(name));
    setUrlInput("");
    setUrlMode(false);
  }

  const trackLabel = settings.fileName || "No track loaded";

  return (
    <div className="bgm-widget">
      {open && (
        <div className="bgm-panel">
          <div className="bgm-panel-title">Background Music</div>

          <div className="bgm-track-row">
            <span className="bgm-track-name" title={trackLabel}>
              {trackLabel}
            </span>
            {settings.fileRef && (
              <button className="bgm-clear-btn" title="Remove track" onClick={onClear}>
                ✕
              </button>
            )}
          </div>

          {urlMode ? (
            <div className="bgm-url-row">
              <input
                type="url"
                className="bgm-url-input"
                placeholder="https://example.com/track.mp3"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleUrlSubmit();
                  if (e.key === "Escape") setUrlMode(false);
                }}
                autoFocus
              />
              <button type="button" className="bgm-url-load-btn" onClick={handleUrlSubmit}>
                Load
              </button>
              <button type="button" className="bgm-url-cancel-btn" onClick={() => setUrlMode(false)}>
                ✕
              </button>
            </div>
          ) : (
            <div className="bgm-source-row">
              <label className="bgm-upload-btn">
                {settings.fileRef ? "Replace Track" : "Upload Track"}
                <input type="file" accept="audio/*" onChange={handleFileChange} style={{ display: "none" }} />
              </label>
              <button type="button" className="bgm-link-btn" onClick={() => setUrlMode(true)}>
                Paste link
              </button>
            </div>
          )}

          <div className="bgm-controls-row">
            <button
              className="bgm-play-btn"
              onClick={togglePlay}
              disabled={!mediaUrl}
              title={playing ? "Pause" : "Play"}
            >
              {playing ? "⏸" : "▶"}
            </button>
            <input
              className="bgm-volume-slider"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={settings.volume}
              onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
              title="Volume"
            />
            <button
              type="button"
              className={"bgm-loop-btn" + (settings.loop ? " is-active" : "")}
              onClick={onToggleLoop}
              title={settings.loop ? "Loop on" : "Loop off"}
              aria-pressed={settings.loop}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 2l4 4-4 4" />
                <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                <path d="M7 22l-4-4 4-4" />
                <path d="M21 13v2a4 4 0 0 1-4 4H3" />
              </svg>
            </button>
          </div>
        </div>
      )}

      <button
        className={"bgm-toggle-btn" + (playing ? " is-playing" : "") + (ducking ? " is-ducked" : "")}
        onClick={() => setOpen((v) => !v)}
        title={ducking ? "Background music (ducked for clue audio)" : "Background music"}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      </button>

      {mediaUrl && (
        <audio
          ref={audioRef}
          src={mediaUrl}
          loop={settings.loop}
          onEnded={() => {
            if (!settings.loop) setPlaying(false);
          }}
        />
      )}
    </div>
  );
}