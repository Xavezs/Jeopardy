// src/components/LoginGate.jsx
import { useEffect, useState } from "react";
import { discordSdk, getDiscordIdentity, resetDiscordSdk } from "../discordSdk";
import { API_BASE } from "../lib/api";
import { DiscordContext } from "./DiscordContext";

export default function LoginGate({ children }) {
  const [status, setStatus] = useState("initializing");
  const [authData, setAuthData] = useState(null);
  // Bumping this re-runs the effect below, letting the Retry button below
  // re-attempt the whole flow in place — no more closing and reopening the
  // entire Activity window just to get a fresh attempt.
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    async function setupDiscordActivity() {
      const queryParams = new URLSearchParams(window.location.search);
      const isDiscordIframe = queryParams.has("frame_id");

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
          setStatus("error");
          return;
        }
        try {
          const user = await getDiscordIdentity();
          if (!user) throw new Error("No identity returned from Discord");

          setAuthData({
            sdk: discordSdk,
            user,
            guildId: discordSdk.guildId,
            channelId: discordSdk.channelId,
            instanceId: discordSdk.instanceId,
          });
          setStatus("in");
        } catch (err) {
          console.error("Discord SDK authorization failed:", err);
          setStatus("error");
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

            setAuthData({
              sdk: null,
              user: data.user,
              guildId: "mock_guild",
              channelId: "mock_channel",
              instanceId: "mock_instance",
            });
            setStatus("in");
          } catch (err) {
            console.error("Dev authentication failed:", err);
            setStatus("error");
          }
          return;
        }

        setStatus("error");
      }
    }

    setupDiscordActivity();
  }, [retryCount]);

  if (status === "initializing") {
    return (
      <main style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", color: "#fff" }}>
        <h3>Loading Discord Activity…</h3>
      </main>
    );
  }

  if (status === "error") {
    return (
      <main style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", color: "#ff4d4d", flexDirection: "column", gap: "12px" }}>
        <h3>Failed to connect to Discord</h3>
        <p>Make sure this app is running inside Discord as an Activity or backend server is active.</p>
        <button
          onClick={() => {
            resetDiscordSdk();
            setStatus("initializing");
            setRetryCount((n) => n + 1);
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