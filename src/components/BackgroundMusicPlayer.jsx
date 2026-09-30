import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { getMediaUrl } from "../lib/storage";
import { isSoundCloudUrl } from "../lib/soundcloud";
import { subscribeSfxDucking } from "../lib/boardSfx";

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
// How much quieter the track gets while ducked (Daily Double, Final
// Standings celebration, Final Jeopardy media, clue video/audio, etc.)
// — 0 means fully silent. Was 0.15 (still faintly audible under
// whatever triggered the duck); changed to a hard mute since that's
// what "duck the BGM" was actually meant to mean here — e.g. Final
// Standings is supposed to be the celebration sound alone, not the
// celebration mixed with a quiet BGM bed. The transition itself is
// still smooth (see fadeVolumeTo below) — only the target changed, not
// how it gets there.
const DUCK_LEVEL = 0;
const DUCK_FADE_MS = 700;
// Master ceiling for the BGM source itself — even at slider max, actual
// gain never exceeds this. Keep in sync with PlayerBgmWidget.jsx so the
// track is equally quiet overall for host and players alike.
const MASTER_BGM_GAIN = 0.6;
// How long the fade-in takes whenever playback actually starts, so it
// doesn't snap straight to full gain. Keep in sync with PlayerBgmWidget.jsx.
const FADE_IN_MS = 900;
// How long the OLD track fades out before a round switch (perRound mode)
// swaps the <audio> src to the new round's track. Kept shorter than
// FADE_IN_MS so a round change reads as "duck out, then bloom back in"
// rather than two equally-long fades blurring into one long crossfade.
// Keep in sync with PlayerBgmWidget.jsx.
const ROUND_FADE_OUT_MS = 500;

// Human hearing perceives loudness roughly logarithmically, while
// <audio>.volume is linear — squaring the slider value (a common taper
// approximation) makes the low end of the slider actually feel quiet.
// Mirrors calcGain() in PlayerBgmWidget.jsx so host and players behave
// the same way for the same slider position.
function calcGain(sliderVolume) {
  return sliderVolume * sliderVolume * MASTER_BGM_GAIN;
}

export default function BackgroundMusicPlayer({
  // `track` is the currently ACTIVE track — either the universal track or
  // the current round's track, already resolved by useBgmSettings based
  // on `mode`. `volume` stays separate/global (see bgmStore.js).
  track,
  volume,
  mode = "universal",
  onSetMode,
  roundLabel,
  onUploadFile,
  onSetDirectUrl,
  onClear,
  onVolumeChange,
  onToggleLoop,
  ducking: duckingProp = false,
  onPlaybackChange,
  finalStandingsVolume = 1,
  onFinalStandingsVolumeChange,
}) {
  // Merge the caller's own ducking signal (clue video/audio play state,
  // wired in from JeopardyBoard/useClueEditor) with boardSfx's shared bus
  // (Daily Double sting, Final Standings celebration, Final Jeopardy
  // media) — either source is enough to duck. Previously this component
  // only ever looked at the prop, so the bus's signal never actually
  // reached the host's own BGM despite PlayerBgmWidget already listening
  // to it on the player side.
  const [busDucking, setBusDucking] = useState(false);
  useEffect(() => subscribeSfxDucking(setBusDucking), []);
  const ducking = duckingProp || busDucking;
  // Effects below that intentionally exclude `ducking`/`volume` from
  // their dependency array (round-transition fade-in, mainly) still
  // need the *current* value at the moment they actually act, not
  // whatever was captured when the effect was set up — the async gap
  // between "effect starts" (old track fading out, new URL resolving)
  // and "fade-in actually happens" is exactly the kind of window
  // ducking can flip during. Mirrored via refs kept in sync every
  // render instead.
  const duckingRef = useRef(ducking);
  const volumeRef = useRef(volume);
  useEffect(() => {
    duckingRef.current = ducking;
    volumeRef.current = volume;
  });

  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [mediaUrl, setMediaUrl] = useState("");
  const [urlMode, setUrlMode] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState("");
  const audioRef = useRef(null);
  const fadeRafRef = useRef(null);
  // Tracks whether we were mid-playback right before `track` changed, so
  // that switching rounds in "perRound" mode can carry playback straight
  // into the new track instead of forcing the host to hit play again
  // every round switch.
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    wasPlayingRef.current = playing;
  }, [playing]);

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
  //
  // If we were already playing right before `track` changed (typically:
  // host switched rounds while music was playing in "perRound" mode),
  // carry playback straight into the new track instead of leaving it
  // paused — that's the whole point of having different music per round.
  useEffect(() => {
    let cancelled = false;
    let urlToRevoke = "";
    const shouldResume = wasPlayingRef.current;

    async function resolve() {
      if (!track.fileRef) {
        setMediaUrl("");
        setPlaying(false);
        return;
      }
      const url = await getMediaUrl(track.fileRef);
      if (cancelled) {
        if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
        return;
      }
      urlToRevoke = url && url.startsWith("blob:") ? url : "";
      setMediaUrl(url);
      if (!shouldResume) {
        setPlaying(false);
        return;
      }
      // Wait a tick so the <audio> element actually picks up the new src
      // before we try to play it.
      requestAnimationFrame(() => {
        if (cancelled) return;
        const audio = audioRef.current;
        if (!audio) return;
        audio.volume = 0;
        audio
          .play()
          .then(() => {
            setPlaying(true);
            fadeVolumeTo(calcGain(duckingRef.current ? volumeRef.current * DUCK_LEVEL : volumeRef.current), FADE_IN_MS);
          })
          .catch(() => setPlaying(false));
      });
    }

    async function run() {
      // If a track was already playing right before this switch (a
      // round change in "perRound" mode is the only way `track` changes
      // while music is live), fade it out first instead of just letting
      // React swap the <audio> src out from under it — without this,
      // switching rounds hard-cut the old track dead silent the instant
      // the src attribute changed, then hard-started the new one at full
      // volume a tick later. This makes it read as a proper "duck out,
      // swap, bloom in" transition instead.
      const audio = audioRef.current;
      if (shouldResume && audio && !audio.paused) {
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
      if (urlToRevoke) URL.revokeObjectURL(urlToRevoke);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.fileRef]);

  useEffect(() => {
    if (audioRef.current) {
      cancelFade();
      audioRef.current.volume = calcGain(ducking ? volume * DUCK_LEVEL : volume);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, mediaUrl]);
  useEffect(() => {
    if (audioRef.current) audioRef.current.loop = track.loop;
  }, [track.loop, mediaUrl]);

  useEffect(() => {
    const target = calcGain(ducking ? volume * DUCK_LEVEL : volume);
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
      fileRef: track.fileRef || "",
      fileName: track.fileName || "",
      loop: !!track.loop,
      playing,
      positionSeconds: audioRef.current ? audioRef.current.currentTime : 0,
      updatedAt: Date.now(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, track.fileRef, track.loop]);

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
          fadeVolumeTo(calcGain(ducking ? volume * DUCK_LEVEL : volume), FADE_IN_MS);
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

  const trackLabel = track.fileName || "No track loaded";
  const hasTrack = !!track.fileRef;
  const isPerRound = mode === "perRound";

  return createPortal(
    <div className="bgm-widget">
      {open && (
        <div className="bgm-panel">
          <div className="bgm-panel-title">Background Music</div>

          {onSetMode && (
            <div className="bgm-mode-row" role="radiogroup" aria-label="Music mode">
              <button
                type="button"
                className={"bgm-mode-btn" + (!isPerRound ? " is-active" : "")}
                aria-pressed={!isPerRound}
                onClick={() => onSetMode("universal")}
                title="One track plays through every round"
              >
                Universal
              </button>
              <button
                type="button"
                className={"bgm-mode-btn" + (isPerRound ? " is-active" : "")}
                aria-pressed={isPerRound}
                onClick={() => onSetMode("perRound")}
                title="Each round gets its own track"
              >
                Per Round
              </button>
            </div>
          )}

          {isPerRound && roundLabel && (
            <div className="bgm-round-label">Editing track for: {roundLabel}</div>
          )}

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
              value={volume}
              onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
              title="Volume"
            />
            <button
              type="button"
              className={"bgm-loop-btn" + (track.loop ? " is-active" : "")}
              onClick={onToggleLoop}
              title={track.loop ? "Loop on" : "Loop off"}
              aria-pressed={track.loop}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 2l4 4-4 4" />
                <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                <path d="M7 22l-4-4 4-4" />
                <path d="M21 13v2a4 4 0 0 1-4 4H3" />
              </svg>
            </button>
          </div>

          {onFinalStandingsVolumeChange && (
            <div className="bgm-fs-volume-row">
              <span
                className="bgm-fs-volume-label"
                title="Volume for the Final Standings celebration sound — separate from the BGM track above"
              >
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
                className="bgm-fs-volume-slider"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={finalStandingsVolume}
                onChange={(e) => onFinalStandingsVolumeChange(parseFloat(e.target.value))}
                title="Final Standings celebration sound volume"
              />
            </div>
          )}
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
          loop={track.loop}
          onEnded={() => {
            if (!track.loop) setPlaying(false);
          }}
        />
      )}
    </div>,
    document.body
  );
}