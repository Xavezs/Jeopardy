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
    const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{6,})/);
    return m ? `https://www.youtube.com/embed/${m[1]}` : null;
  }
}
export function toPerceptualVolume(sliderValue, exponent = 3) {
  return Math.pow(sliderValue, exponent);
}
export function isDataUrl(s) {
  return typeof s === "string" && s.indexOf("data:") === 0;
}
export function humanSize(bytes) {
  return bytes > 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB";
}