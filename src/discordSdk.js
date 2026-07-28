// src/discordSdk.js
import { DiscordSDK } from '@discord/embedded-app-sdk';

const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID;

// The SDK constructor itself throws if `frame_id` isn't in the URL query —
// that's only true when we're genuinely embedded in Discord's iframe. In a
// plain browser tab (local dev, or someone opening the link directly)
// there's no frame_id, so constructing it unconditionally crashes the
// entire app at module-load time, before React ever renders. Guard on
// frame_id first, and wrap the construction itself in try/catch too.
const hasFrameId = new URLSearchParams(window.location.search).has('frame_id');

let sdkInstance = null;
if (clientId && hasFrameId) {
  try {
    sdkInstance = new DiscordSDK(clientId);
  } catch (err) {
    console.warn("DiscordSDK construction failed, continuing without it:", err.message);
    sdkInstance = null;
  }
}

export const discordSdk = sdkInstance;

// Discord launches the Activity with `channel_id` (and `instance_id`) in the
// URL query string alongside `frame_id`. This is the same channel the
// Activity is running in, and it's what SPEAKING_START/SPEAKING_STOP need
// to be scoped to when subscribing. Falls back to null in standalone
// browser mode, where there's no voice channel to watch anyway.
export const activityChannelId = hasFrameId
  ? new URLSearchParams(window.location.search).get('channel_id')
  : null;

// Guards against calling discordSdk.commands.authorize() more than once
// concurrently. React Strict Mode (and any other double-invocation of an
// effect that calls this) would otherwise fire a second authorize() while
// the first is still in flight — Discord's SDK rejects that second call
// with "Already authing", and without this cache, whichever call resolves
// second (the failed one) can overwrite a perfectly good result with null.
// Callers that arrive while a call is in progress just await the same
// promise instead of starting a new one.
let setupPromise = null;

export async function setupDiscordSdk() {
  if (!discordSdk) {
    console.warn("Discord SDK skipped: no frame_id (not running inside Discord) or VITE_DISCORD_CLIENT_ID is missing.");
    return null;
  }

  if (setupPromise) return setupPromise;

  setupPromise = (async () => {
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Discord SDK ready timeout')), 2000)
      );

      await Promise.race([discordSdk.ready(), timeoutPromise]);
      console.log("Discord SDK is ready!");

      const { code } = await discordSdk.commands.authorize({
        client_id: clientId,
        response_type: 'code',
        state: '',
        // Back to 'none': once a user has granted 'rpc.voice.read' one
        // time, Discord silently reuses that existing grant instead of
        // showing the consent screen on every single Activity reload.
        // 'consent' should only go back on temporarily if you add ANOTHER
        // new scope in the future and need everyone to be re-prompted for
        // it once — revert to 'none' again right after, same as this time.
        prompt: 'none',
        // 'identify' covers authenticateDiscordUser's needs (id/username/
        // avatar via the server-side token exchange). 'rpc.voice.read' is
        // back because live speaking-state (the green glow on team cards)
        // is read directly from the Activity SDK's SPEAKING_START/
        // SPEAKING_STOP RPC events, which require this scope.
        //
        // IMPORTANT: rpc.voice.read is a privileged scope — it must be
        // enabled/approved for this application in the Discord Developer
        // Portal (Activities > OAuth2 Scopes) or authorize() will fail for
        // every user, every time (the same "Discord SDK authorization
        // failed" loop this scope caused before it was removed). Confirm
        // that approval is in place before relying on this in real testing.
        scope: ['identify', 'rpc.voice.read'],
      });

      return code;
    } catch (err) {
      console.warn("Discord SDK setup bypassed or failed (likely running in standalone browser mode):", err.message);
      return null;
    } finally {
      // Allow a fresh attempt on a future call (e.g. a later remount after
      // navigating away and back) rather than caching a failure forever.
      setupPromise = null;
    }
  })();

  return setupPromise;
}

// Exchanges the auth `code` for the user's Discord identity via YOUR server
// (never do the token exchange from the client — it needs your app's
// client secret). Hits the route already built in auth.js, which does the
// code->token exchange AND fetches /users/@me for you, returning
// { id, username, avatarUrl } — no separate SDK re-authentication needed.
//
// `credentials: "include"` matters here: auth.js sets an httpOnly session
// cookie on this response, and inside the Discord Activity iframe that's a
// cross-site request, so the cookie won't be set/sent without it.
export async function authenticateDiscordUser(code) {
  if (!code) return null;

  try {
    const response = await fetch("/api/auth/token", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        // Tells auth.js's cookieOptions() to issue a Secure, partitioned
        // cookie (required cross-site) instead of the plain dev cookie.
        ...(discordSdk ? { "x-discord-activity": "1" } : {}),
      },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`);
    const { user, access_token } = await response.json();
    return user ? { ...user, access_token } : null; // { id, username, avatarUrl, access_token }
  } catch (err) {
    console.warn("Discord identity lookup failed (likely standalone browser mode):", err.message);
    return null;
  }
}

// Combines setupDiscordSdk() + authenticateDiscordUser() into one
// page-lifetime-cached flow. This is the piece that was missing: without
// it, a StrictMode remount (mount -> cleanup -> mount again, which React
// does deliberately in dev) re-runs a component's identity-resolving
// effect a second time, and each run independently calls authorize() and
// POSTs a fresh code to /token. Discord's RPC layer can reject a second
// authorize() call arriving while the first hasn't fully settled ("invalid
// request"), which is exactly the double-exchange/failure pattern seen in
// bot-server's logs. Caching the whole flow here means every caller within
// this page load — however many times their effect happens to fire —
// shares one resolution instead of each kicking off their own.
//
// Callers (e.g. PlayerView.jsx) should use this instead of calling
// setupDiscordSdk()/authenticateDiscordUser() separately.
let identityPromise = null;

export function getDiscordIdentity() {
  if (identityPromise) return identityPromise;

  identityPromise = (async () => {
    const code = await setupDiscordSdk();
    console.log("[speaking-debug] setupDiscordSdk code:", code ? "(got code)" : code);
    if (!code) return null;

    const identity = await authenticateDiscordUser(code);
    console.log("[speaking-debug] authenticateDiscordUser identity:", identity ? { ...identity, access_token: identity.access_token ? "(present)" : identity.access_token } : identity);
    if (!identity) return null;

    const { access_token, ...user } = identity;

    // This is the step that was missing: authorize() + the server-side
    // code->token exchange only gets us a `code`/`access_token` and lets
    // our own backend look up who the user is — it does NOT tell the SDK
    // itself who's logged in. discordSdk.commands.authenticate() is what
    // actually hands the access_token back to the SDK and establishes an
    // authenticated RPC session. Without this call, discordSdk.subscribe()
    // for SPEAKING_START/SPEAKING_STOP resolves without throwing (looks
    // fine, no console error) but never receives any events, because the
    // RPC layer never had a session to attach the subscription to.
    if (discordSdk && access_token) {
      try {
        await discordSdk.commands.authenticate({ access_token });
        console.log("[speaking-debug] discordSdk.commands.authenticate() succeeded");
      } catch (err) {
        console.warn("[speaking-debug] discordSdk.commands.authenticate() failed:", err.message, err);
      }
    } else {
      console.warn("[speaking-debug] authenticate() skipped: discordSdk =", !!discordSdk, "access_token =", !!access_token);
    }

    return user; // { id, username, avatarUrl } — same shape as before
  })();

  return identityPromise;
}