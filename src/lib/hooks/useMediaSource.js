import { useState, useEffect } from 'react';

// How long to wait for the proxy before giving up. The backend media proxy
// queues/throttles Google Drive requests (see media.js), so under load this
// can legitimately take a few seconds — 20s gives it room without leaving
// the player stuck forever if something's actually wrong.
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
    // Relative/malformed URL edge case — fall back to a plain string
    // append rather than letting the retry silently lose the param.
    return url + (url.includes('?') ? '&' : '?') + 'force=1';
  }
}

// Shared by CustomAudioPlayer, CustomVideoPlayer, and ClueMediaImage.
// Discord's Activity proxy (/.proxy/...) doesn't reliably forward
// Range-request streaming for larger files, so instead of pointing the
// <audio>/<video>/<img> element at the proxied URL directly, this fetches
// it once as a whole blob and serves it from a local blob URL — one clean
// download, no ranged requests for the proxy to mishandle.
//
// `options.label` ("Audio"/"Video"/"Image") only affects the "X failed to
// load: ..." message text. `options.logPrefix` (e.g. "[CustomVideoPlayer]",
// "[ClueMediaImage]") is the console.error prefix — callers differ here
// since it doesn't always match "Custom<label>Player". `options.onFail`,
// if given, is called once per failed load with (err, timedOut), for a
// caller that needs a side effect beyond the returned prefetchError (e.g.
// ClueMediaImage's onLoadError, used to cascade to a different media type
// when the guessed type turns out wrong).
export function useMediaSource(src, { label, logPrefix, onFail } = {}) {
  const [resolvedSrc, setResolvedSrc] = useState('');
  const [prefetching, setPrefetching] = useState(false);
  // Surfaced in the UI so a stuck load reads as "still waiting" vs
  // "actually failed" instead of an indefinite "Loading…".
  const [prefetchError, setPrefetchError] = useState('');
  // Bumped by the manual "Retry" button. >0 means this run should bypass
  // the browser's HTTP cache — the automatic retry above only helps with a
  // transient network blip, but if the clue's media file was replaced at
  // the same URL, the browser may have a stale cached response that a
  // plain re-fetch would just hand back again.
  const [manualRetryCount, setManualRetryCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let blobUrl = null;
    setResolvedSrc('');
    setPrefetchError('');
    setPrefetching(false);

    if (!src) return;

    // Already-local resources don't need re-fetching.
    if (src.startsWith('blob:') || src.startsWith('data:')) {
      setResolvedSrc(src);
      return;
    }

    const bypassCache = manualRetryCount > 0;
    const fetchUrl = bypassCache ? withForceParam(src) : src;

    // Aborts the in-flight fetch (and its timeout) whenever src changes or
    // this effect is torn down, instead of letting an abandoned request
    // run to completion and occupy a slot in the backend's proxy queue for
    // no reason.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    setPrefetching(true);
    (async () => {
      try {
        let blob;
        try {
          blob = await fetchAsBlob(fetchUrl, controller.signal, bypassCache);
        } catch (firstErr) {
          // One retry for a plain network hiccup — but not if we were
          // aborted (deliberate cancel/timeout) or the component
          // unmounted, since retrying either of those would be pointless.
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
        const message = timedOut
          ? `${label} failed to load: timed out waiting for the server.`
          : `${label} failed to load: ` + (err?.message || 'unknown error');
        console.error(`${logPrefix} blob prefetch failed:`, err, 'src=' + src);
        setPrefetchError(message);
        onFail && onFail(err, timedOut);
        // Only fall back to the raw src if we weren't the ones who
        // aborted it — a timed-out/aborted request has nothing useful to
        // fall back to, and a CSP-blocked URL will just fail again the
        // same way.
        if (!timedOut) setResolvedSrc(src);
      } finally {
        if (!cancelled) setPrefetching(false);
        clearTimeout(timeoutId);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timeoutId);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [src, manualRetryCount]);

  return {
    resolvedSrc,
    prefetching,
    prefetchError,
    retry: () => setManualRetryCount((n) => n + 1),
  };
}