import { api } from "./api";

// Web (non-Discord) session: reuse an existing login/guest cookie, otherwise ask the server for a guest.
// The server mints the guest id, name and signed token; nothing here is trusted by the server.
let sessionPromise = null;

function normalize(user) {
  return { ...user, avatarUrl: user.avatarUrl || null, platform: "web" };
}

export function ensureWebSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    try {
      let { user } = await api("/api/auth/me");
      if (!user) ({ user } = await api("/api/auth/guest", { method: "POST" }));
      if (!user) throw new Error("No user returned");
      return normalize(user);
    } catch (err) {
      console.warn("Web session unavailable:", err.message);
      sessionPromise = null; // allow a retry
      return null;
    }
  })();
  return sessionPromise;
}

export function resetWebSession() {
  sessionPromise = null;
}
