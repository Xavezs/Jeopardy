import React, { useEffect, useRef, useState } from "react";
import { getYoutubeVideoId, loadYoutubeIframeApi } from "../lib/youtube";

let instanceCounter = 0;

// Drop-in replacement for the plain YouTube <iframe> that was previously used
// in ClueModal. A static iframe has no way to report or receive play state,
// so a YouTube clue played independently on the host and on every player —
// no sync at all. This wraps the YouTube IFrame Player API so the component
// exposes the SAME props/callbacks as CustomVideoPlayer:
//   - onPlayStateChange(isPlaying, currentTime) -> host reports state up
//   - isPlaying / currentTime (external)         -> players get driven by host
//   - disablePlayPause / disableSeeking          -> players can't fight the host
// This lets it plug into your existing onDuckMusic / onMediaStateChange wiring
// with zero changes to that side of the pipeline.
export default function YoutubePlayer({
  src,
  onError,
  onPlayStateChange,
  isPlaying: externalIsPlaying,
  currentTime: externalCurrentTime,
  disablePlayPause = false,
  disableSeeking = false,
}) {
  const elementIdRef = useRef(`yt-player-${++instanceCounter}`);
  const playerRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [internalIsPlaying, setInternalIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(80); // YT API volume is 0-100
  const [isMuted, setIsMuted] = useState(false);

  const videoId = getYoutubeVideoId(src);
  const isPlaying = externalIsPlaying !== undefined ? externalIsPlaying : internalIsPlaying;

  // Create the player once per videoId.
  useEffect(() => {
    if (!videoId) return;
    let destroyed = false;

    loadYoutubeIframeApi()
      .then((YT) => {
        if (destroyed) return;
        // Direct the YT.Player constructor to load the iframe directly from
        // https://www.youtube.com. Proxying the entire iframe document under our same-origin
        // domain (via /youtube-embed) breaks YouTube's root-relative asset requests
        // (like /s/player/...), causing 404s and a black video player.
        // As long as youtube.com is configured as an allowed frame origin in the Discord
        // Developer Portal, Discord's CSP will permit framing it directly.
        playerRef.current = new YT.Player(elementIdRef.current, {
          videoId,
          host: "https://www.youtube.com",
          playerVars: {
            rel: 0,
            playsinline: 1,
            controls: 0, // we render our own controls, same as CustomVideoPlayer
            modestbranding: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (e) => {
              if (destroyed) return;
              setReady(true);
              setDuration(e.target.getDuration());
              e.target.setVolume(volume);
            },
            onStateChange: (e) => {
              if (destroyed) return;
              // YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
              if (e.data === 1) {
                setInternalIsPlaying(true);
                onPlayStateChange && onPlayStateChange(true, e.target.getCurrentTime());
              } else if (e.data === 2) {
                setInternalIsPlaying(false);
                onPlayStateChange && onPlayStateChange(false, e.target.getCurrentTime());
              } else if (e.data === 0) {
                setInternalIsPlaying(false);
                setCurrentTime(0);
                onPlayStateChange && onPlayStateChange(false, 0);
              }
            },
            onError: (e) => {
              console.error("[YoutubePlayer] YT.Player error code", e.data, "videoId=", videoId);
              onError && onError(e);
            },
          },
        });
      })
      .catch((err) => {
        console.error("[YoutubePlayer] failed to load IFrame API:", err);
        onError && onError(err);
      });

    return () => {
      destroyed = true;
      setReady(false);
      if (playerRef.current && playerRef.current.destroy) {
        playerRef.current.destroy();
      }
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // The IFrame API has no timeupdate event, so poll while mounted to keep
  // the seek bar and clock moving.
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => {
      if (playerRef.current && playerRef.current.getCurrentTime) {
        setCurrentTime(playerRef.current.getCurrentTime());
      }
    }, 250);
    return () => clearInterval(id);
  }, [ready]);

  // Heartbeat: same pattern as CustomVideoPlayer — periodically re-broadcast
  // position while playing so late-joining or drifted players self-correct
  // without waiting on a fresh play/pause/seek event.
  useEffect(() => {
    if (!ready || !isPlaying || !onPlayStateChange) return;
    const id = setInterval(() => {
      if (playerRef.current && playerRef.current.getCurrentTime) {
        onPlayStateChange(true, playerRef.current.getCurrentTime());
      }
    }, 2000);
    return () => clearInterval(id);
  }, [ready, isPlaying, onPlayStateChange]);

  // Sync external isPlaying (player clients being driven by the host's state).
  useEffect(() => {
    if (!ready || !playerRef.current || externalIsPlaying === undefined) return;
    if (externalIsPlaying) {
      playerRef.current.playVideo();
    } else {
      playerRef.current.pauseVideo();
    }
  }, [externalIsPlaying, ready]);

  // Sync external currentTime. YouTube seeks are coarser/slower than <video>,
  // so a wider drift threshold (1s) avoids constant micro-seeking/stutter.
  useEffect(() => {
    if (!ready || !playerRef.current || externalCurrentTime === undefined) return;
    const current = playerRef.current.getCurrentTime ? playerRef.current.getCurrentTime() : 0;
    if (Math.abs(current - externalCurrentTime) > 1) {
      playerRef.current.seekTo(externalCurrentTime, true);
      setCurrentTime(externalCurrentTime);
    }
  }, [externalCurrentTime, ready]);

  const togglePlay = () => {
    if (disablePlayPause || !playerRef.current) return;
    if (internalIsPlaying) {
      playerRef.current.pauseVideo();
    } else {
      playerRef.current.playVideo();
    }
  };

  const handleSeek = (e) => {
    if (disableSeeking || !playerRef.current) return;
    const time = parseFloat(e.target.value);
    playerRef.current.seekTo(time, true);
    setCurrentTime(time);
    onPlayStateChange && onPlayStateChange(isPlaying, time);
  };

  const handleVolumeChange = (e) => {
    const v = Math.round(parseFloat(e.target.value) * 100);
    setVolume(v);
    setIsMuted(v === 0);
    if (playerRef.current) {
      playerRef.current.setVolume(v);
      if (v === 0) playerRef.current.mute();
      else playerRef.current.unMute();
    }
  };

  const formatTime = (time) => {
    if (isNaN(time)) return "0:00";
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
  };

  if (!videoId) {
    return (
      <div className="player-video-overlay">
        <span style={{ fontSize: 13, color: "#fff" }}>Invalid YouTube link</span>
      </div>
    );
  }

  return (
    <div className="custom-video-player">
      <div className="player-video-frame" onClick={togglePlay}>
        <div id={elementIdRef.current} className="player-video-el" />

        {!ready && (
          <div className="player-video-overlay">
            <span style={{ fontSize: 13, color: "#fff" }}>Loading video…</span>
          </div>
        )}
        {ready && !isPlaying && (
          <div className="player-video-overlay">
            <svg viewBox="0 0 24 24" className="player-icon play-arrow player-video-big-play">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        )}

        <div className="custom-video-controls" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={togglePlay}
            disabled={disablePlayPause}
            className="player-play-btn"
            title={isPlaying ? "Pause" : "Play"}
            style={disablePlayPause ? { cursor: "not-allowed", opacity: 0.8 } : {}}
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

          <div className="player-timeline">
            <span className="player-time">{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={duration || 100}
              value={currentTime}
              onChange={handleSeek}
              disabled={disableSeeking}
              className="player-slider timeline-slider"
              style={{
                cursor: disableSeeking ? "not-allowed" : "pointer",
                background: `linear-gradient(to right, #f59e0b 0%, #f59e0b ${(currentTime / (duration || 1)) * 100}%, #1e293b ${(currentTime / (duration || 1)) * 100}%, #1e293b 100%)`,
              }}
            />
            <span className="player-time">{formatTime(duration)}</span>
          </div>

          <div className="player-volume-container">
            <button
              onClick={() => handleVolumeChange({ target: { value: isMuted ? 0.8 : 0 } })}
              className="player-volume-btn"
              title={isMuted ? "Unmute" : "Mute"}
            >
              {isMuted || volume === 0 ? (
                <svg viewBox="0 0 24 24" className="player-icon">
                  <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.21.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
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
              value={isMuted ? 0 : volume / 100}
              onChange={handleVolumeChange}
              className="player-slider volume-slider"
              style={{
                background: `linear-gradient(to right, #f59e0b 0%, #f59e0b ${(isMuted ? 0 : volume)}%, #1e293b ${(isMuted ? 0 : volume)}%, #1e293b 100%)`,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
