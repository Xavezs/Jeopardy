import React, { useEffect, useState } from 'react';

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
    return url + (url.includes('?') ? '&' : '?') + 'force=1';
  }
}

// Renders clue image media (question or answer)
export default function ClueMediaImage({ src, alt = '', className, onLoadError }) {
  const [resolvedSrc, setResolvedSrc] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
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
        if (!failed) {
          console.error('[ClueMediaImage] blob failed to decode as image, src=' + src);
          setFailed(true);
          onLoadError && onLoadError();
        }
      }}
    />
  );
}