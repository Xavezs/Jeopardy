import React, { useState, useEffect, useRef } from "react";
import { getMediaUrl } from "../lib/storage";
import { isSoundCloudUrl } from "../lib/soundcloud";

/* =========================================================================
   BACKGROUND MUSIC PLAYER
   A small floating widget (bottom-right corner) that stays out of the way
   of the board. Collapsed, it's just a round note button; clicking it
   opens a compact panel with upload / play / volume / loop controls.

   Track source: an uploaded file (stored in MediaStore) OR a direct
   http(s) audio link — both play through a plain <audio> element.

   NOTE: SoundCloud embedding was removed. Their widget needs several
   cross-origin scripts (widget.sndcdn.com, dwt.soundcloud.com, etc.)
   that Discord's Activity CSP blocks no matter how many URL Mappings are
   added, since those domains are hardcoded as absolute URLs inside
   SoundCloud's own HTML — not something Discord's simple prefix-based
   proxy can rewrite. See lib/soundcloud.js for the full story. A pasted
   SoundCloud link is now just rejected with a clear message instead of
   silently failing.
   ========================================================================= */
const DUCK_LEVEL = 0.15;
const DUCK_FADE_MS = 700;
// Master ceiling for the BGM source itself — even at slider max, actual
// gain never exceeds this. Keep in sync with PlayerBgmWidget.jsx so the
// track is equally quiet overall for host and players alike.
const MASTER_BGM_GAIN = 0.6;
// How long the fade-in takes whenever playback actually starts, so it
// doesn't snap straight to full gain. Keep in sync with PlayerBgmWidget.jsx.
const FADE_IN_MS = 900;

// Human hearing perceives loudness roughly logarithmically, while
// <audio>.volume is linear — squaring the slider value (a common taper
// approximation) makes the low end of the slider actually feel quiet.
// Mirrors calcGain() in PlayerBgmWidget.jsx so host and players behave
// the same way for the same slider position.
function calcGain(sliderVolume) {
  return sliderVolume * sliderVolume * MASTER_BGM_GAIN;
}

export default function BackgroundMusicPlayer({
  settings,
  onUploadFile,
  onSetDirectUrl,
  onClear,
  onVolumeChange,
  onToggleLoop,
  ducking = false,
  onPlaybackChange,
}) {
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [mediaUrl, setMediaUrl] = useState("");
  const [urlMode, setUrlMode] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState("");
  const audioRef = useRef(null);
  const fadeRafRef = useRef(null);

  function cancelFade() {
    if (fadeRafRef.current != null) {
      cancelAnimationFrame(fadeRafRef.current);
      fadeRafRef.current = null;
    }
  }

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

  // Resolve the current track's fileRef into a playable URL. Old saved
  // settings from before SoundCloud was removed might still have
  // source: "soundcloud" lying around — just ignore that and fall back
  // to fileRef (or nothing) rather than trying to handle it.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.fileRef]);

  useEffect(() => {
    if (audioRef.current) {
      cancelFade();
      audioRef.current.volume = calcGain(ducking ? settings.volume * DUCK_LEVEL : settings.volume);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.volume, mediaUrl]);
  useEffect(() => {
    if (audioRef.current) audioRef.current.loop = settings.loop;
  }, [settings.loop, mediaUrl]);

  useEffect(() => {
    const target = calcGain(ducking ? settings.volume * DUCK_LEVEL : settings.volume);
    if (!audioRef.current) return;
    fadeVolumeTo(target);
    return cancelFade;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ducking]);

  useEffect(() => cancelFade, []);

  useEffect(() => {
    if (!onPlaybackChange) return;
    onPlaybackChange({
      source: "file",
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
      cancelFade();
      audio.pause();
      setPlaying(false);
    } else {
      audio.volume = 0;
      audio
        .play()
        .then(() => {
          setPlaying(true);
          fadeVolumeTo(calcGain(ducking ? settings.volume * DUCK_LEVEL : settings.volume), FADE_IN_MS);
        })
        .catch(() => setPlaying(false));
    }
  }

  function handleFileChange(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (file) onUploadFile(file);
  }

  function handleUrlSubmit() {
    const trimmed = urlInput.trim();
    if (!trimmed || !/^https?:\/\//i.test(trimmed)) return;
    if (isSoundCloudUrl(trimmed)) {
      setUrlError("SoundCloud links aren't supported here — please upload the audio file instead, or paste a direct .mp3 link.");
      return;
    }
    const name = trimmed.split("/").pop().split(/[?#]/)[0] || "External track";
    onSetDirectUrl(trimmed, decodeURIComponent(name));
    setUrlInput("");
    setUrlError("");
    setUrlMode(false);
  }

  const trackLabel = settings.fileName || "No track loaded";
  const hasTrack = !!settings.fileRef;

  return (
    <div className="bgm-widget">
      {open && (
        <div className="bgm-panel">
          <div className="bgm-panel-title">Background Music</div>

          <div className="bgm-track-row">
            <span className="bgm-track-name" title={trackLabel}>
              {trackLabel}
            </span>
            {hasTrack && (
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
                onChange={(e) => {
                  setUrlInput(e.target.value);
                  if (urlError) setUrlError("");
                }}
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
              {urlError && <div className="bgm-url-error">{urlError}</div>}
            </div>
          ) : (
            <div className="bgm-source-row">
              <label className="bgm-upload-btn">
                {hasTrack ? "Replace Track" : "Upload Track"}
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