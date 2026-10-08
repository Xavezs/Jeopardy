import React, { useRef, useState, useEffect } from 'react';
import { toPerceptualVolume } from '../lib/utils';
import { useMediaSource } from '../lib/hooks/useMediaSource';
import { useClipCutoff } from '../lib/hooks/useClipCutoff';

export default function CustomVideoPlayer({ 
  src, 
  onError, 
  onPlayStateChange,
  isPlaying: externalIsPlaying,
  currentTime: externalCurrentTime,
  disablePlayPause = false,
  disableSeeking = false,
  clipSeconds = null,
}) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const [internalIsPlaying, setInternalIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8); // Default 80% volume
  const [isMuted, setIsMuted] = useState(false);
  const [prevVolume, setPrevVolume] = useState(0.8);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const { resolvedSrc, prefetching, prefetchError, retry } = useMediaSource(src, {
    label: 'Video',
    logPrefix: '[CustomVideoPlayer]',
  });

  const isPlaying = externalIsPlaying !== undefined ? externalIsPlaying : internalIsPlaying;
  const clipCutoff = useClipCutoff(clipSeconds, isPlaying, videoRef);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = isMuted ? 0 : toPerceptualVolume(volume);
    }
  }, [volume, isMuted]);

  // Sync external isPlaying state from host
  useEffect(() => {
    if (!videoRef.current || !resolvedSrc || externalIsPlaying === undefined) return;
    if (externalIsPlaying) {
      const playPromise = videoRef.current.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise
          .then(() => setAutoplayBlocked(false))
          .catch(() => setAutoplayBlocked(true));
      }
    } else {
      videoRef.current.pause();
      setAutoplayBlocked(false);
    }
    setInternalIsPlaying(externalIsPlaying);
  }, [externalIsPlaying, resolvedSrc]);

  // Sync external currentTime from host
  useEffect(() => {
    if (!videoRef.current || !resolvedSrc || externalCurrentTime === undefined) return;
    if (Math.abs(videoRef.current.currentTime - externalCurrentTime) > 0.5) {
      videoRef.current.currentTime = externalCurrentTime;
      setCurrentTime(externalCurrentTime);
    }
  }, [externalCurrentTime]);

  // Safety net on unmount
  useEffect(() => {
    return () => onPlayStateChange && onPlayStateChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track fullscreen changes (e.g. user hits Esc)
  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const togglePlay = () => {
    if (disablePlayPause) return; // Prevent manual toggle for players
    if (!videoRef.current) return;
    if (internalIsPlaying) {
      videoRef.current.pause();
      onPlayStateChange && onPlayStateChange(false, videoRef.current.currentTime);
      setInternalIsPlaying(false);
    } else {
      clipCutoff.arm(videoRef.current.currentTime);
      videoRef.current.play();
      onPlayStateChange && onPlayStateChange(true, videoRef.current.currentTime);
      setInternalIsPlaying(true);
    }
  };

  useEffect(() => {
    if (!isPlaying || !onPlayStateChange) return;
    const id = setInterval(() => {
      if (videoRef.current) {
        onPlayStateChange(true, videoRef.current.currentTime);
      }
    }, 2000);
    return () => clearInterval(id);
  }, [isPlaying, onPlayStateChange]);

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    // Clip cutoff
    if (clipCutoff.hasReachedCutoff(videoRef.current.currentTime)) {
      handleClipEnd();
      return;
    }
    setCurrentTime(videoRef.current.currentTime);
  };

  const handleClipEnd = () => {
    const startTime = clipCutoff.clipStartTime();
    videoRef.current.pause();
    videoRef.current.currentTime = startTime;
    if (externalIsPlaying === undefined) {
      setInternalIsPlaying(false);
    }
    setCurrentTime(startTime);
    onPlayStateChange && onPlayStateChange(false, startTime);
    clipCutoff.disarm();
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
    }
  };

  const handleSeek = (e) => {
    if (disableSeeking) return; // Prevent manual scrubbing for players
    const time = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      if (isPlaying) clipCutoff.arm(time); else clipCutoff.disarm();
      setCurrentTime(time);
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

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
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
    if (videoRef.current) videoRef.current.currentTime = 0;
    setCurrentTime(0);
    onPlayStateChange && onPlayStateChange(false, 0);
  };

  const handleUnlockClick = (e) => {
    e.stopPropagation();
    if (!videoRef.current) return;
    videoRef.current
      .play()
      .then(() => setAutoplayBlocked(false))
      .catch(() => {});
  };

  return (
    <div className="custom-video-player" ref={containerRef}>
      <div className="player-video-frame" onClick={togglePlay}>
        <video
          ref={videoRef}
          {...(resolvedSrc ? { src: resolvedSrc } : {})}
          playsInline
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={handleEnded}
          onError={(e) => {
            const mediaError = e?.currentTarget?.error;
            // MediaError.code: 1=ABORTED 2=NETWORK 3=DECODE 4=SRC_NOT_SUPPORTED
            console.error(
              '[CustomVideoPlayer] video failed to load/decode:',
              'code=' + (mediaError?.code ?? 'unknown'),
              mediaError?.message || '(no message)',
              'src=' + resolvedSrc
            );
            onError && onError(e);
          }}
          className="player-video-el"
        />
        {prefetching && (
          <div className="player-video-overlay clue-media-status" style={{ flexDirection: 'column', gap: 8 }}>
            <span>Loading video…</span>
          </div>
        )}
        {!prefetching && prefetchError && (
          <div
            className="player-video-overlay clue-media-status is-error"
            style={{ flexDirection: 'column', gap: 8, pointerEvents: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <span>Failed to load video</span>
            <button
              type="button"
              className="clue-media-retry-btn"
              onClick={retry}
            >
              Retry
            </button>
          </div>
        )}
        {!prefetching && !prefetchError && !isPlaying && !(autoplayBlocked && disablePlayPause) && (
          <div className="player-video-overlay">
            <svg viewBox="0 0 24 24" className="player-icon play-arrow player-video-big-play">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        )}
        {!prefetching && autoplayBlocked && disablePlayPause && (
          <div
            className="player-video-overlay"
            onClick={handleUnlockClick}
            style={{ cursor: 'pointer', flexDirection: 'column', gap: 8 }}
          >
            <svg viewBox="0 0 24 24" className="player-icon play-arrow player-video-big-play">
              <path d="M8 5v14l11-7z" />
            </svg>
            <span style={{ fontSize: 13, color: '#fff' }}>Tap to start video</span>
          </div>
        )}

        <div className="custom-video-controls" onClick={(e) => e.stopPropagation()}>
          {/* Play/Pause Button */}
          <button 
            onClick={togglePlay} 
            disabled={disablePlayPause} 
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

          {/* Track & Timers */}
          <div className="player-timeline">
            <span className="player-time">{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={duration || 100}
              value={currentTime}
              onInput={handleSeek}
              onChange={handleSeek}
              disabled={disableSeeking}
              className="player-slider timeline-slider"
              style={{
                cursor: disableSeeking ? 'not-allowed' : 'pointer',
                background: `linear-gradient(to right, #f59e0b 0%, #f59e0b ${(currentTime / (duration || 1)) * 100}%, #1e293b ${(currentTime / (duration || 1)) * 100}%, #1e293b 100%)`
              }}
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
                background: `linear-gradient(to right, #f59e0b 0%, #f59e0b ${(isMuted ? 0 : volume) * 100}%, #1e293b ${(isMuted ? 0 : volume) * 100}%, #1e293b 100%)`
              }}
            />
          </div>

          {/* Fullscreen Toggle */}
          <button onClick={toggleFullscreen} className="player-volume-btn" title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}>
            {isFullscreen ? (
              <svg viewBox="0 0 24 24" className="player-icon">
                <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="player-icon">
                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}