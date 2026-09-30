// src/components/LoginGate.jsx
import { useEffect, useState } from "react";
import { discordSdk, getDiscordIdentity } from "../discordSdk";
import { API_BASE } from "../lib/api";
import { DiscordContext } from "./DiscordContext";

// Tracks "a reload-retry was already attempted for this failure" across the
// actual page reload the Retry button now does (a plain useState/useRef
// wouldn't survive that — the whole app remounts fresh). sessionStorage is
// scoped to this tab/webview, same pattern as discordSdk.js's fake-player
// identity cache.
//
// Why this exists: a plain reload only fixes a WEDGED IFRAME DOCUMENT — it
// can't fix a wedged RPC SESSION on Discord's own side (see discordSdk.js's
// resetDiscordSdk() comment). If the first reload-retry didn't clear the
// error, a second click is very unlikely to either, and just loops the user
// through the same failure. Once we know a retry already happened, the
// error screen switches to telling them to close and reopen the Activity
// panel instead of offering another Retry click.
const RETRY_FLAG_KEY = "jeopardy_discord_retry_attempted_at";
const RETRY_FLAG_TTL_MS = 2 * 60 * 1000; // stale after 2 min — treat as a fresh failure

function hasRecentRetryAttempt() {
  const raw = sessionStorage.getItem(RETRY_FLAG_KEY);
  if (!raw) return false;
  const ts = Number(raw);
  if (!ts || Date.now() - ts > RETRY_FLAG_TTL_MS) {
    sessionStorage.removeItem(RETRY_FLAG_KEY);
    return false;
  }
  return true;
}

export default function LoginGate({ children }) {
  const [status, setStatus] = useState("initializing");
  const [authData, setAuthData] = useState(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const isDiscordIframe = new URLSearchParams(window.location.search).has("frame_id");

    function setStatusIfActive(nextStatus) {
      if (!cancelled) setStatus(nextStatus);
    }

    async function setupDiscordActivity() {
      if (isDiscordIframe) {
        // --- 1. RUNNING INSIDE DISCORD ACTIVITY IFRAME ---
        // Reuses the shared, page-lifetime-cached getDiscordIdentity()
        // flow from discordSdk.js instead of calling
        // discordSdk.ready()/commands.authorize() directly here.
        //
        // This used to be a separate, uncached implementation. In React
        // StrictMode (and on any double-mount) that fired a second
        // authorize() while the first was still in flight, which Discord's
        // SDK rejects with "Already authing" — the failed call's promise
        // never resolved status to "in" or "error" cleanly, leaving the
        // screen stuck on "Loading Discord Activity..." forever. That
        // failure mode only showed up here (Host) because the Join flow
        // in App.jsx already went through getDiscordIdentity()'s shared
        // setupPromise/identityPromise cache; this path didn't.
        //
        // getDiscordIdentity() internally calls discordSdk.ready(),
        // commands.authorize() (scope: ['identify', 'rpc.voice.read'] —
        // see discordSdk.js for why 'guilds' was dropped), exchanges the
        // code via POST /api/auth/token, and calls
        // discordSdk.commands.authenticate() with the resulting
        // access_token. It returns { id, username, avatarUrl } or null.
        if (!discordSdk) {
          console.error("Discord SDK unavailable: missing VITE_DISCORD_CLIENT_ID or SDK construction failed.");
          setStatusIfActive("error");
          return;
        }
        try {
          const user = await getDiscordIdentity();
          if (!user) throw new Error("No identity returned from Discord");

          if (!cancelled) {
            sessionStorage.removeItem(RETRY_FLAG_KEY);
            setAuthData({
              sdk: discordSdk,
              user,
              guildId: discordSdk.guildId,
              channelId: discordSdk.channelId,
              instanceId: discordSdk.instanceId,
            });
            setStatus("in");
          }
        } catch (err) {
          console.error("Discord SDK authorization failed:", err);
          setStatusIfActive("error");
        }
      } else {
        // --- 2. RUNNING IN STANDALONE BROWSER MODE ---
        console.log("Running in local browser mode (Outside Discord iframe)");

        if (import.meta.env.DEV) {
          try {
            const res = await fetch(`${API_BASE}/api/auth/dev-login`, {
              method: "POST",
              credentials: "include",
            });

            if (!res.ok) {
              throw new Error(`Auth endpoint returned status ${res.status}`);
            }

            const data = await res.json();

            if (!cancelled) {
              setAuthData({
                sdk: null,
                user: data.user,
                guildId: "mock_guild",
                channelId: "mock_channel",
                instanceId: "mock_instance",
              });
              setStatus("in");
            }
          } catch (err) {
            console.error("Dev authentication failed:", err);
            setStatusIfActive("error");
          }
          return;
        }

        setStatusIfActive("error");
      }
    }

    setupDiscordActivity();

    return () => {
      cancelled = true;
    };
  }, [retryCount]);

  if (status === "initializing") {
    return (
      <main style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", color: "#fff", background: "#070a20" }}>
        <h3>Loading Discord Activity…</h3>
      </main>
    );
  }

  if (status === "error") {
    const alreadyRetried = hasRecentRetryAttempt();

    if (alreadyRetried) {
      // A reload-retry already happened and STILL failed — that means the
      // problem is Discord's own RPC session for this iframe, not
      // something a page reload (or another one) can reach. Only closing
      // the Activity panel and relaunching it forces Discord to hand out a
      // genuinely new session, so tell people that directly instead of
      // handing them a Retry button that's already shown it won't help.
      return (
        <main style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", color: "#ff4d4d", flexDirection: "column", gap: "12px", background: "#070a20", textAlign: "center", padding: "0 24px" }}>
          <h3>Still can't connect to Discord</h3>
          <p style={{ maxWidth: "420px", color: "#ddd" }}>
            Retry already tried and didn't fix it this usually means Discord's connection to this Activity is stuck, which a reload can't repair.
          </p>
          <p style={{ maxWidth: "420px", fontWeight: 600 }}>
            Please close this Activity panel completely and reopen it from the voice channel.
          </p>
          <button
            onClick={() => {
              sessionStorage.removeItem(RETRY_FLAG_KEY);
              window.location.reload();
            }}
            style={{ marginTop: "8px", padding: "4px 12px", borderRadius: "6px", border: "1px solid #444", background: "transparent", color: "#999", cursor: "pointer", fontSize: "12px" }}
          >
            Try again anyway
          </button>
        </main>
      );
    }

    return (
      <main style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", color: "#ff4d4d", flexDirection: "column", gap: "12px", background: "#070a20" }}>
        <h3>Failed to connect to Discord</h3>
        <p>Make sure this app is running inside Discord as an Activity or backend server is active.</p>
        <button
          onClick={() => {
            // resetDiscordSdk() alone only rebuilds JS-side SDK state — it
            // can't fix a "ready handshake timeout" / "No identity
            // returned", because that means Discord's own RPC channel to
            // THIS iframe is wedged (see learnings: Discord frequently
            // suspends/hides the Activity iframe instead of destroying it,
            // and the RPC transport doesn't reconnect on its own). A full
            // reload navigates the iframe's document, which is the closest
            // thing to "close and reopen the panel" a Retry click can do —
            // window.location.reload() preserves the exact current URL, so
            // frame_id/channel_id/instance_id (read once at module load in
            // discordSdk.js) survive intact; nothing is lost since nothing
            // past this gate has rendered yet.
            //
            // Marks the retry attempt BEFORE reloading (sessionStorage
            // survives the reload) so that if this same error is still
            // showing after the reload, the branch above takes over instead
            // of offering a Retry that's already been shown not to help.
            sessionStorage.setItem(RETRY_FLAG_KEY, String(Date.now()));
            window.location.reload();
          }}
          style={{ padding: "8px 20px", borderRadius: "6px", border: "none", background: "#5865F2", color: "#fff", cursor: "pointer", fontSize: "14px" }}
        >
          Retry
        </button>
      </main>
    );
  }

  return (
    <DiscordContext.Provider value={authData}>
      {children}
    </DiscordContext.Provider>
  );
}