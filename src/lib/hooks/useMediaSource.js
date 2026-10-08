import { useState, useEffect } from 'react';

const FETCH_TIMEOUT_MS = 45000;

async function fetchAsBlob(url, signal, bypassCache) {
  const res = await fetch(url, { signal, cache: bypassCache ? 'no-store' : 'default' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.blob();
}

function withForceParam(url) {
  try {
    const u = new URL(url, window.location.origin);
    u.searchParams.set('force', '1');
    return u.toString();
  } catch {
    // Relative/malformed URL edge case
    return url + (url.includes('?') ? '&' : '?') + 'force=1';
  }
}

// Shared by CustomAudioPlayer, CustomVideoPlayer, and ClueMediaImage
export function useMediaSource(src, { label, logPrefix, onFail } = {}) {
  const [resolvedSrc, setResolvedSrc] = useState('');
  const [prefetching, setPrefetching] = useState(false);
  const [prefetchError, setPrefetchError] = useState('');
  const [manualRetryCount, setManualRetryCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let blobUrl = null;
    setResolvedSrc('');
    setPrefetchError('');
    setPrefetching(false);

    if (!src) return;

    // Already-local resources don't need re-fetching
    if (src.startsWith('blob:') || src.startsWith('data:')) {
      setResolvedSrc(src);
      return;
    }

    const bypassCache = manualRetryCount > 0;
    const fetchUrl = bypassCache ? withForceParam(src) : src;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    setPrefetching(true);
    (async () => {
      try {
        let blob;
        try {
          blob = await fetchAsBlob(fetchUrl, controller.signal, bypassCache);
        } catch (firstErr) {
          // One retry for a plain network hiccup
          if (cancelled || controller.signal.aborted) throw firstErr;
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