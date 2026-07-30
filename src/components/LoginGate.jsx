// src/components/LoginGate.jsx
import { useEffect, useState, createContext, useContext } from "react";
import { discordSdk } from "../discordSdk";
import { API_BASE } from "../lib/api";

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;
export const DiscordContext = createContext(null);

export default function LoginGate({ children }) {
  const [status, setStatus] = useState("initializing");
  const [authData, setAuthData] = useState(null);

  useEffect(() => {
    async function setupDiscordActivity() {
      const queryParams = new URLSearchParams(window.location.search);
      const isDiscordIframe = queryParams.has("frame_id");

      if (isDiscordIframe) {
        // --- 1. RUNNING INSIDE DISCORD ACTIVITY IFRAME ---
        // Reuses the single guarded DiscordSDK instance from discordSdk.js
        // instead of constructing a second one here. Two separate SDK
        // instances both try to complete the RPC handshake against the
        // same frame_id, and Discord's RPC server only tracks one live
        // handshake per frame — the loser gets a confusing "Unrecognized
        // frame ID" RPCError. One instance, shared, avoids the race.
        if (!discordSdk) {
          console.error("Discord SDK unavailable: missing VITE_DISCORD_CLIENT_ID or SDK construction failed.");
          setStatus("error");
          return;
        }
        try {
          await discordSdk.ready();

          const { code } = await discordSdk.commands.authorize({
            client_id: CLIENT_ID,
            response_type: "code",
            state: "",
            prompt: "none",
            scope: ["identify", "guilds"],
          });

          const res = await fetch(`${API_BASE}/api/auth/token`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Discord-Activity": "1",
            },
            credentials: "include",
            body: JSON.stringify({ code }),
          });

          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Failed to exchange token");

          await discordSdk.commands.authenticate({ access_token: data.access_token });

          setAuthData({
            sdk: discordSdk,
            user: data.user,
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
          // src/components/LoginGate.jsx (inside the fallback block)
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
  }, []);

  if (status === "initializing") {
    return (
      <main style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", color: "#fff" }}>
        <h3>Loading Discord Activity…</h3>
      </main>
    );
  }

  if (status === "error") {
    return (
      <main style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", color: "#ff4d4d", flexDirection: "column" }}>
        <h3>Failed to connect to Discord</h3>
        <p>Make sure this app is running inside Discord as an Activity or backend server is active.</p>
      </main>
    );
  }

  return (
    <DiscordContext.Provider value={authData}>
      {children}
    </DiscordContext.Provider>
  );
}

export const useDiscordAuth = () => useContext(DiscordContext);