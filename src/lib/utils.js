export function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

export function youTubeEmbed(url) {
  if (typeof url !== "string" || !url.trim()) return null;

  // Preferred path: parse as a real URL so query params can be read
  // regardless of order (e.g. "watch?list=...&v=ID" as well as
  // "watch?v=ID&list=..."), and so subdomains (m., music., www.) and the
  // /live/ path (streams & premieres, previously unsupported) are handled
  // explicitly instead of via one broad regex.
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^(www|m|music)\./, "");

    if (host === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }

    if (host === "youtube.com") {
      if (u.pathname === "/watch") {
        const id = u.searchParams.get("v");
        return id ? `https://www.youtube.com/embed/${id}` : null;
      }
      const pathMatch = u.pathname.match(/^\/(embed|shorts|live)\/([a-zA-Z0-9_-]{6,})/);
      if (pathMatch) return `https://www.youtube.com/embed/${pathMatch[2]}`;
    }
    return null;
  } catch {
    // Not a parseable absolute URL (e.g. a bare "youtube.com/watch?v=ID"
    // with no scheme) — fall back to the old regex for that shape only.
    const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{6,})/);
    return m ? `https://www.youtube.com/embed/${m[1]}` : null;
  }
}
// Native HTMLMediaElement.volume is linear (0-1), but human hearing is
// logarithmic — so a slider at 10-20% still sounds loud. Curving the value
// before writing it to the element approximates perceived loudness. Bump
// the exponent higher if it's still too loud at low slider positions,
// lower if it drops off too fast.
export function toPerceptualVolume(sliderValue, exponent = 3) {
  return Math.pow(sliderValue, exponent);
}
export function isDataUrl(s) {
  return typeof s === "string" && s.indexOf("data:") === 0;
}
export function humanSize(bytes) {
  return bytes > 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB";
}