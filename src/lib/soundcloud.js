// lib/soundcloud.js
// SoundCloud embedding was removed for Background Music: their widget
// requires loading additional cross-origin scripts (widget.sndcdn.com,
// dwt.soundcloud.com, etc.) that Discord's Activity CSP blocks no matter
// how many URL Mappings are added — those domains are hardcoded as
// absolute URLs inside SoundCloud's own served HTML, which isn't
// something a simple prefix-based reverse proxy (Discord's URL Mappings)
// can rewrite. Confirmed by curling the proxied widget page directly and
// finding it references https://widget.sndcdn.com/... via <script src>,
// which is a different origin than the w.soundcloud.com URL Mapping and
// gets blocked by script-src regardless.
//
// Kept only so BackgroundMusicPlayer/PlayerBgmWidget can detect a pasted
// SoundCloud link and show a clear "not supported" message instead of
// silently failing or trying (and failing) to embed it.
export function isSoundCloudUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "soundcloud.com" || host.endsWith(".soundcloud.com") || host === "on.soundcloud.com";
  } catch {
    return false;
  }
}