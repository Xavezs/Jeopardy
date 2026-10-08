export function isSoundCloudUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "soundcloud.com" || host.endsWith(".soundcloud.com") || host === "on.soundcloud.com";
  } catch {
    return false;
  }
}