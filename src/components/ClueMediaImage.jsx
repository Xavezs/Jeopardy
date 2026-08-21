import React, { useEffect, useState } from 'react';

// How long to wait for the proxy before giving up. The backend media proxy
// queues/throttles Google Drive requests and forwards generic third-party
// URLs through its own fetch (see media.js), so under load this can
// legitimately take a few seconds — 20s gives it room without leaving the
// image stuck forever if something's actually wrong.
const FETCH_TIMEOUT_MS = 45000;

async function fetchAsBlob(url, signal, bypassCache) {
  const res = await fetch(url, { signal, cache: bypassCache ? 'no-store' : 'default' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.blob();
}

// A manual Retry click bypasses the browser's HTTP cache (bypassCache
// above) but the server also holds its own short-lived negative cache for
// failed Google Drive fetches (see media.js) — without this, a retry
// within that window just gets served the same cached error back
// instantly, without the server ever trying Google again. Appending
// force=1 tells the server to skip that cache and make a real attempt.
// Only used for the manual retry, never the automatic first retry below,
// so a normal transient blip still benefits from the server's in-flight
// request coalescing instead of doubling up load on Google.
function withForceParam(url) {
  try {
    const u = new URL(url, window.location.origin);
    u.searchParams.set('force', '1');
    return u.toString();
  } catch {
    return url + (url.includes('?') ? '&' : '?') + 'force=1';
  }
}

/**
 * Renders clue image media (question or answer). Unlike a plain
 * <img src={mediaUrl}>, this fetches through the same blob-prefetch path
 * as CustomAudioPlayer/CustomVideoPlayer — with a timeout and one retry —
 * instead of leaving the browser to stream the proxied URL directly with
 * no timeout and no visible "still loading" state.
 *
 * onLoadError is called once, after the retry is exhausted or the request
 * times out, so the caller can decide what to do (e.g. only cascade to a
 * video/audio player when the media type was a guess, not a confirmed one).
 */
export default function ClueMediaImage({ src, alt = '', className, onLoadError }) {
  const [resolvedSrc, setResolvedSrc] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // Bumped by the manual "Retry" button. >0 means this run should bypass
  // the browser's HTTP cache (cache: 'no-store') — the automatic retry
  // above only helps with a transient network blip, but if the clue's
  // media file was replaced at the same URL (e.g. the same Google Drive
  // link re-uploaded with new content), the browser may have a stale
  // cached response that a plain re-fetch would just hand back again.
  const [manualRetryCount, setManualRetryCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let blobUrl = null;
    setResolvedSrc('');
    setFailed(false);

    if (!src) return;

    if (src.startsWith('blob:') || src.startsWith('data:')) {
      setResolvedSrc(src);
      return;
    }

    const bypassCache = manualRetryCount > 0;
    const fetchUrl = bypassCache ? withForceParam(src) : src;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    setLoading(true);
    (async () => {
      try {
        let blob;
        try {
          blob = await fetchAsBlob(fetchUrl, controller.signal, bypassCache);
        } catch (firstErr) {
          if (cancelled || controller.signal.aborted) throw firstErr;
          // Brief pause before retrying: firing again instantly tends to
          // land on the exact same failure (server-side negative cache,
          // or a Google rate-limit wall that hasn't cleared yet) — a short
          // wait gives that window a chance to pass. Cancelled early if
          // the component unmounts or the fetch times out while waiting.
          await new Promise((resolve) => {
            const t = setTimeout(resolve, 1500);
            controller.signal.addEventListener('abort', () => {
              clearTimeout(t);
              resolve();
            });
          });
          if (cancelled || controller.signal.aborted) throw firstErr;
          blob = await fetchAsBlob(fetchUrl, controller.signal, bypassCache);
        }
        if (cancelled) return;
        blobUrl = URL.createObjectURL(blob);
        setResolvedSrc(blobUrl);
      } catch (err) {
        if (cancelled) return;
        const timedOut = controller.signal.aborted;
        console.error(
          '[ClueMediaImage] failed to load:',
          timedOut ? 'timed out waiting for the server' : err?.message || 'unknown error',
          'src=' + src
        );
        setFailed(true);
        onLoadError && onLoadError();
      } finally {
        if (!cancelled) setLoading(false);
        clearTimeout(timeoutId);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timeoutId);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, manualRetryCount]);

  if (loading) {
    return <div className="clue-media-status">Loading image…</div>;
  }

  if (failed) {
    return (
      <div className="clue-media-status is-error">
        <span>Failed to load image</span>
        <button
          type="button"
          className="clue-media-retry-btn"
          onClick={() => setManualRetryCount((n) => n + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!resolvedSrc) return null;

  return (
    <img
      src={resolvedSrc}
      alt={alt}
      className={className}
      onError={() => {
        // The blob itself loaded but couldn't be decoded as an image
        // (corrupt file, wrong content-type served, etc.) — same terminal
        // failure as a fetch error, so report it the same way.
        if (!failed) {
          console.error('[ClueMediaImage] blob failed to decode as image, src=' + src);
          setFailed(true);
          onLoadError && onLoadError();
        }
      }}
    />
  );
}