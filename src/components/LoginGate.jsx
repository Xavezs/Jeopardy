import { useEffect, useState } from "react";
import { discordSdk, getDiscordIdentity } from "../discordSdk";
import { api, API_BASE } from "../lib/api";
import { isDiscordActivity } from "../lib/environment";
import { DiscordContext } from "./DiscordContext";

const RETRY_FLAG_KEY = "jeopardy_discord_retry_attempted_at";
const RETRY_FLAG_TTL_MS = 2 * 60 * 1000;

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
        // 1. RUNNING INSIDE DISCORD ACTIVITY IFRAME
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
        // 2. RUNNING IN A NORMAL BROWSER
        // Hosting needs a real Discord account. Players never pass through LoginGate: PlayerView gives them a guest session.
        try {
          const { user } = await api("/api/auth/me");
          if (user && !user.guest) {
            if (!cancelled) {
              setAuthData({ sdk: null, user, guildId: null, channelId: null, instanceId: null });
              setStatus("in");
            }
            return;
          }
        } catch (err) {
          console.warn("Could not check web session:", err.message);
        }

        if (import.meta.env.DEV) {
          try {
            const res = await fetch(`${API_BASE}/api/auth/dev-login`, {
              method: "POST",
              credentials: "include",
            });
            if (res.ok) {
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
              return;
            }
          } catch (err) {
            console.warn("Dev login unavailable:", err.message);
          }
        }

        setStatusIfActive("login");
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
        <h3>{isDiscordActivity ? "Loading Discord Activity…" : "Loading…"}</h3>
      </main>
    );
  }

  if (status === "login") {
    return (
      <main style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", color: "#fff", flexDirection: "column", gap: "12px", background: "#070a20", textAlign: "center", padding: "0 24px" }}>
        <h3>Log in to host</h3>
        <p style={{ maxWidth: "420px", color: "#ddd" }}>
          Hosting and editing boards on the web needs a Discord account. Players can join a room without logging in.
        </p>
        <a
          href={`${API_BASE}/api/auth/discord`}
          style={{ padding: "8px 20px", borderRadius: "6px", background: "#5865F2", color: "#fff", textDecoration: "none", fontSize: "14px" }}
        >
          Log in with Discord
        </a>
        <button
          onClick={() => {
            sessionStorage.removeItem("jeopardy:active-host-mode");
            window.location.reload();
          }}
          style={{ marginTop: "4px", padding: "4px 12px", borderRadius: "6px", border: "1px solid #444", background: "transparent", color: "#999", cursor: "pointer", fontSize: "12px" }}
        >
          Back
        </button>
      </main>
    );
  }

  if (status === "error") {
    const alreadyRetried = hasRecentRetryAttempt();

    if (alreadyRetried) {
      // A reload-retry already happened and STILL failed
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