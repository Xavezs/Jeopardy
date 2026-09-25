import React, { useRef, useState, useEffect } from 'react';
import { toPerceptualVolume } from '../lib/utils';
import { useMediaSource } from '../lib/hooks/useMediaSource';
import { useClipCutoff } from '../lib/hooks/useClipCutoff';

export default function CustomAudioPlayer({ 
  src, 
  onError,
  onPlayStateChange, 
  isPlaying: externalIsPlaying, 
  currentTime: externalCurrentTime, 
  disablePlayPause = false, 
  disableSeeking = false,
  // Per-clue "stop after N seconds" cutoff (see useClueEditor.js's
  // mediaClipSeconds/answerMediaClipSeconds) — undefined/null/0 means play
  // in full. Built for "1-second music round"-style clues.
  clipSeconds = null,
}) {
  const audioRef = useRef(null);
  const timelineRef = useRef(null);
  const [internalIsPlaying, setInternalIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8); // Default 80% volume
  const [isMuted, setIsMuted] = useState(false);
  const [prevVolume, setPrevVolume] = useState(0.8);
  // Same class of autoplay-policy issue as the video player, just less
  // likely to hit in practice for audio-only elements. Tracked so we can
  // surface a tap-to-unlock affordance instead of silently stalling.
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  // Same reasoning as the video player: Discord's Activity proxy doesn't
  // reliably forward Range-request streaming for larger files, so we fetch
  // once as a whole blob and play from a local blob URL instead of letting
  // the <audio> element stream the proxied URL directly.
  const { resolvedSrc, prefetching, prefetchError, retry } = useMediaSource(src, {
    label: 'Audio',
    logPrefix: '[CustomAudioPlayer]',
  });

  const isPlaying = externalIsPlaying !== undefined ? externalIsPlaying : internalIsPlaying;
  const clipCutoff = useClipCutoff(clipSeconds, isPlaying, audioRef);

  // Keep audio volume in sync with React state
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : toPerceptualVolume(volume);
    }
  }, [volume, isMuted]);

  // Sync external isPlaying state from host
  useEffect(() => {
    if (!audioRef.current || !resolvedSrc || externalIsPlaying === undefined) return;
    if (externalIsPlaying) {
      const playPromise = audioRef.current.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise
          .then(() => setAutoplayBlocked(false))
          .catch(() => setAutoplayBlocked(true));
      }
    } else {
      audioRef.current.pause();
      setAutoplayBlocked(false);
    }
    // Keep the internal toggle-button state lined up with whatever the
    // parent just forced (e.g. auto-pausing on a buzz-in). Without this,
    // internalIsPlaying goes stale after an external override, and the
    // play/pause button's own click handler (which only reads
    // internalIsPlaying, not the external prop) ends up doing nothing —
    // or the opposite of what the icon shows — on the next click.
    setInternalIsPlaying(externalIsPlaying);
  }, [externalIsPlaying, resolvedSrc]);

  // Sync external currentTime from host (corrects drift). The tolerance
  // scales down for short clips — a fixed 0.5s snap is imperceptible on a
  // 3-minute track but is ~12% of a 4-second clue clip, so every
  // correction reads as a visible stutter. Floor of 0.15s keeps it from
  // getting so tight it fights normal network jitter.
  useEffect(() => {
    if (!audioRef.current || !resolvedSrc || externalCurrentTime === undefined) return;
    const driftTolerance = duration > 0 ? Math.max(0.15, Math.min(0.5, duration * 0.08)) : 0.5;
    if (Math.abs(audioRef.current.currentTime - externalCurrentTime) > driftTolerance) {
      audioRef.current.currentTime = externalCurrentTime;
      setCurrentTime(externalCurrentTime);
      paintTimeline(externalCurrentTime);
    }
  }, [externalCurrentTime, resolvedSrc, duration]);

  // Native range inputs don't let the thumb travel the full 100% of the
  // track — it's confined to (trackWidth - thumbWidth) so it never pokes
  // out past either end. A gradient stop set to raw `percent%` ignores
  // that inset, so it visibly drifts from the thumb's real center as you
  // approach either edge. Mixing in a px offset (derived from the CSS
  // thumb width below) corrects for it. Must match .player-slider
  // ::-webkit-slider-thumb / ::-moz-range-thumb width in board.css.
  const THUMB_SIZE_PX = 14;
  function trackFillPosition(percent) {
    const offsetPx = THUMB_SIZE_PX * (0.5 - percent / 100);
    return `calc(${percent}% + ${offsetPx}px)`;
  }

  // Writes both the thumb position and the gradient fill straight to the
  // slider DOM node. Used everywhere the timeline needs to move (the rAF
  // loop, seeking, external sync, load, end) so the slider stays
  // uncontrolled by React — a controlled `value` prop would fight these
  // direct writes every time React re-renders with a slightly-stale
  // `currentTime`, undoing the smoothing this is meant to provide.
  function paintTimeline(time) {
    const slider = timelineRef.current;
    if (!slider) return;
    const pct = (time / (duration || 1)) * 100;
    slider.value = time;
    slider.style.background = `linear-gradient(to right, #f59e0b 0%, #f59e0b ${trackFillPosition(pct)}, #1e293b ${trackFillPosition(pct)}, #1e293b 100%)`;
  }

  // Drive the visible progress (slider thumb + track fill) off a rAF loop
  // that writes straight to the DOM node, instead of calling setState
  // every frame. A setState-per-frame approach re-renders this whole
  // component (and re-runs every inline style computation) up to 60x/sec,
  // which is exactly the kind of overhead that shows up as a stuttering
  // thumb rather than a smooth glide — especially once this sits inside a
  // larger board tree. React's `currentTime` state is still updated, just
  // throttled to a few times a second — plenty for the digits label and
  // for handleSeek's baseline, without needing 60 renders/sec.
  useEffect(() => {
    if (!isPlaying) return;
    let rafId;
    let lastStateSync = 0;
    const tick = (now) => {
      const audio = audioRef.current;
      if (audio) {
        const t = audio.currentTime;
        paintTimeline(t);
        if (now - lastStateSync > 200) {
          setCurrentTime(t);
          lastStateSync = now;
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, duration]);

  // Safety net on unmount
  useEffect(() => {
    return () => onPlayStateChange && onPlayStateChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePlay = () => {
    if (disablePlayPause) return; // Prevent manual toggle for players
    if (!audioRef.current) return;
    if (internalIsPlaying) {
      audioRef.current.pause();
      onPlayStateChange && onPlayStateChange(false, audioRef.current.currentTime);
      setInternalIsPlaying(false);
    } else {
      clipCutoff.arm(audioRef.current.currentTime);
      audioRef.current.play();
      onPlayStateChange && onPlayStateChange(true, audioRef.current.currentTime);
      setInternalIsPlaying(true);
    }
  };

  // Heartbeat: periodically re-broadcast current position while playing, so
  // late-joining or drifted players get corrected without needing a fresh
  // play/pause/seek event to happen first.
  useEffect(() => {
    if (!isPlaying || !onPlayStateChange) return;
    const id = setInterval(() => {
      if (audioRef.current) {
        onPlayStateChange(true, audioRef.current.currentTime);
      }
    }, 2000);
    return () => clearInterval(id);
  }, [isPlaying, onPlayStateChange]);

  const handleTimeUpdate = () => {
    if (!audioRef.current) return;
    // Clip cutoff — checked before the normal state update below so a
    // cut clip never briefly shows a currentTime past the limit. Unlike
    // the browser's own `ended` event, hitting this doesn't pause the
    // element automatically, so handleClipEnd does that explicitly.
    if (clipCutoff.hasReachedCutoff(audioRef.current.currentTime)) {
      handleClipEnd();
      return;
    }
    setCurrentTime(audioRef.current.currentTime);
    paintTimeline(audioRef.current.currentTime);
  };

  // Same externally-visible effect as handleEnded below (pause, notify
  // parent) but for a clip hitting its configured limit rather than the
  // media's own natural end — the native `ended` event never fires here,
  // so this has to pause the element itself. Unlike handleEnded, this
  // rewinds to where the clip *started* (clipCutoff.clipStartTime())
  // rather than to 0, so replaying the clue replays the same clip instead
  // of the start of the whole file.
  const handleClipEnd = () => {
    const startTime = clipCutoff.clipStartTime();
    audioRef.current.pause();
    audioRef.current.currentTime = startTime;
    if (externalIsPlaying === undefined) {
      setInternalIsPlaying(false);
    }
    setCurrentTime(startTime);
    paintTimeline(startTime);
    onPlayStateChange && onPlayStateChange(false, startTime);
    clipCutoff.disarm();
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
      paintTimeline(audioRef.current.currentTime);
    }
  };

  const handleSeek = (e) => {
    if (disableSeeking) return; // Prevent manual scrubbing for players
    const time = parseFloat(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      if (isPlaying) clipCutoff.arm(time); else clipCutoff.disarm();
      setCurrentTime(time);
      paintTimeline(time);
      onPlayStateChange && onPlayStateChange(isPlaying, time);
    }
  };

  const handleVolumeChange = (e) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (newVolume > 0) {
      setIsMuted(false);
    }
  };

  const toggleMute = () => {
    if (isMuted) {
      setVolume(prevVolume);
      setIsMuted(false);
    } else {
      setPrevVolume(volume);
      setIsMuted(true);
    }
  };

  const formatTime = (time) => {
    if (isNaN(time)) return '0:00';
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  };

  const handleEnded = () => {
    if (externalIsPlaying === undefined) {
      setInternalIsPlaying(false);
    }
    if (audioRef.current) audioRef.current.currentTime = 0;
    setCurrentTime(0);
    paintTimeline(0);
    onPlayStateChange && onPlayStateChange(false, 0);
  };

  return (
    <div className="custom-audio-player">
      <audio
        ref={audioRef}
        {...(resolvedSrc ? { src: resolvedSrc } : {})}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
        onError={(e) => {
          const mediaError = e?.currentTarget?.error;
          console.error(
            '[CustomAudioPlayer] audio failed to load/decode:',
            'code=' + (mediaError?.code ?? 'unknown'),
            mediaError?.message || '(no message)',
            'src=' + resolvedSrc
          );
          onError && onError(e);
        }}
      />
      {prefetching && (
        <span className="player-time" style={{ opacity: 0.7 }}>Loading…</span>
      )}
      {!prefetching && prefetchError && (
        <span className="clue-media-status is-error is-inline" title={prefetchError}>
          Failed to load
          <button
            type="button"
            className="clue-media-retry-btn"
            onClick={retry}
          >
            Retry
          </button>
        </span>
      )}

      {/* Play/Pause Button */}
      <button 
        onClick={togglePlay} 
        disabled={disablePlayPause || prefetching} 
        className="player-play-btn" 
        title={isPlaying ? "Pause" : "Play"}
        style={disablePlayPause ? { cursor: 'not-allowed', opacity: 0.8 } : {}}
      >
        {isPlaying ? (
          <svg viewBox="0 0 24 24" className="player-icon">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="player-icon play-arrow">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      {autoplayBlocked && disablePlayPause && (
        <button
          className="player-play-btn"
          onClick={() => {
            audioRef.current
              ?.play()
              .then(() => setAutoplayBlocked(false))
              .catch(() => {});
          }}
          title="Tap to enable audio"
          style={{ background: '#f59e0b', color: '#000' }}
        >
          Tap to enable audio
        </button>
      )}

      {/* Track & Timers */}
      <div className="player-timeline">
        <span className="player-time">{formatTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={duration || 100}
          defaultValue={0}
          ref={timelineRef}
          onInput={handleSeek}
          onChange={handleSeek}
          disabled={disableSeeking}
          className="player-slider timeline-slider"
          style={{ cursor: disableSeeking ? 'not-allowed' : 'pointer' }}
        />
        <span className="player-time">{formatTime(duration)}</span>
      </div>

      {/* Volume Controls */}
      <div className="player-volume-container">
        <button onClick={toggleMute} className="player-volume-btn" title={isMuted ? "Unmute" : "Mute"}>
          {isMuted || volume === 0 ? (
            <svg viewBox="0 0 24 24" className="player-icon">
              <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.21.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
            </svg>
          ) : volume < 0.5 ? (
            <svg viewBox="0 0 24 24" className="player-icon">
              <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="player-icon">
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
            </svg>
          )}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={isMuted ? 0 : volume}
          onChange={handleVolumeChange}
          className="player-slider volume-slider"
          style={{
            background: `linear-gradient(to right, #f59e0b 0%, #f59e0b ${trackFillPosition((isMuted ? 0 : volume) * 100)}, #1e293b ${trackFillPosition((isMuted ? 0 : volume) * 100)}, #1e293b 100%)`
          }}
        />
      </div>
    </div>
  );
}