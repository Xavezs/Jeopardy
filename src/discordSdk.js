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

function createSdkInstance() {
  if (!(clientId && hasFrameId)) return null;
  try {
    return new DiscordSDK(clientId);
  } catch (err) {
    console.warn("DiscordSDK construction failed, continuing without it:", err.message);
    return null;
  }
}

// NOTE: this is `let`, not `const`. Discord frequently suspends/hides the
// Activity iframe instead of destroying it when the panel is closed — the
// JS context (and this module's state) survives, but the underlying RPC
// transport the SDK instance is bound to does NOT reconnect on its own.
// After that happens, discordSdk.ready() on the OLD instance hangs forever
// (never resolves, never rejects) — no amount of retrying .ready() on the
// same dead instance will ever succeed. The only real fix is constructing
// a brand-new DiscordSDK instance, which is what resetDiscordSdk() below
// does. Because this is `let` and exported, ES module live-bindings mean
// every file that does `import { discordSdk } from './discordSdk'` always
// sees the current value automatically — no need to re-import after reset.
export let discordSdk = createSdkInstance();

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

// Separate, permanent cache for the ready() handshake itself. Promise.race
// against a timeout only makes OUR code stop waiting — it does not cancel
// discordSdk.ready(), which keeps resolving in the background regardless.
// Without this cache, every retry (manual retry button, or closing and
// reopening the whole Activity) called discordSdk.ready() again from
// scratch, stacking up multiple concurrent handshakes and making later
// attempts less likely to succeed, not more. Caching it means: if the
// first attempt "times out" from our side but the handshake actually
// completes a moment later, every subsequent retry immediately reuses
// that already-resolved promise instead of starting a new one.
let readyPromise = null;
function getReadyPromise() {
  if (!readyPromise) {
    readyPromise = discordSdk.ready().catch((err) => {
      // If the underlying handshake itself rejects, don't leave that
      // rejection cached forever — clear it so the next call (e.g. the
      // Retry button) issues a genuinely fresh ready() instead of
      // re-awaiting a promise that's already dead.
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

// Forces a completely fresh start: new DiscordSDK instance + every cached
// promise cleared. Use this (rather than just re-calling setupDiscordSdk())
// whenever there's reason to believe the existing RPC connection is dead
// rather than just slow — e.g. the user explicitly hit Retry after a
// "Discord SDK ready timeout", or after closing and reopening the Activity
// panel. Calling setupDiscordSdk()/getDiscordIdentity() again right after
// this will go through the entire ready() -> authorize() -> authenticate()
// flow from scratch on a live connection.
export function resetDiscordSdk() {
  setupPromise = null;
  readyPromise = null;
  identityPromise = null;
  discordSdk = createSdkInstance();
}

export async function setupDiscordSdk(_isSelfHealRetry = false) {
  if (!discordSdk) {
    console.warn("Discord SDK skipped: no frame_id (not running inside Discord) or VITE_DISCORD_CLIENT_ID is missing.");
    return null;
  }

  if (setupPromise) return setupPromise;

  setupPromise = (async () => {
    try {
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Discord SDK ready timeout')), 15000);
      });

      try {
        await Promise.race([getReadyPromise(), timeoutPromise]);
      } catch (raceErr) {
        // IMPORTANT: do NOT null out readyPromise here just because OUR
        // side gave up waiting. Promise.race doesn't cancel
        // discordSdk.ready() — the real handshake keeps running in the
        // background and can still succeed a moment later. If we discard
        // readyPromise on every timeout, the next retry (including the
        // Retry button) starts a brand-new ready() call while the old one
        // is still in flight, and the two concurrent handshakes can
        // interfere with each other on Discord's RPC channel — this is
        // what caused "sometimes it works, sometimes it doesn't" even
        // after raising the timeout value. If the underlying ready()
        // promise genuinely rejects (not just slow), getReadyPromise()'s
        // own .catch already nulls readyPromise for us, so a real retry
        // still gets a fresh attempt when it's actually warranted.
        //
        // SELF-HEAL: a timeout here has a second, very common cause besides
        // "just slow" — the Activity panel was closed and reopened, the old
        // DiscordSDK instance's RPC transport is now permanently dead, and
        // no amount of waiting will ever make it resolve. We can't tell
        // "slow" apart from "dead" in advance, so: on the FIRST timeout,
        // try exactly once more with a completely fresh instance
        // (resetDiscordSdk) before surfacing the error. This makes the
        // dead-connection case (closing/reopening the Activity) recover
        // automatically without the user having to hit Retry manually,
        // while still only costing one extra ~15s wait in the genuinely-
        // slow case. Bounded to one retry (_isSelfHealRetry guard) so a
        // truly broken setup (e.g. missing OAuth scope approval) still
        // fails and shows the error screen instead of looping forever.
        if (!_isSelfHealRetry) {
          console.warn("Discord SDK ready() timed out — retrying once with a fresh connection (Activity panel may have been closed/reopened).");
          resetDiscordSdk();
          // `return await` (not just `return`) matters here: it keeps this
          // function's own `finally { setupPromise = null }` below from
          // running until the retried attempt actually finishes, instead
          // of clearing setupPromise the instant the retry merely starts.
          return await setupDiscordSdk(true);
        }
        throw raceErr;
      } finally {
        clearTimeout(timeoutId);
      }
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
    if (!code) {
      // Don't leave a failed attempt cached forever. Discord frequently
      // suspends/hides the Activity iframe instead of destroying it when
      // the panel is closed, so this module's state can outlive a single
      // "session" from the user's perspective. Without this reset, one
      // failed ready()/authorize() (e.g. a slow tunnel) permanently blocks
      // every future retry with a cached `null` — closing and reopening
      // the Activity panel would never work again without a hard reload.
      identityPromise = null;
      return null;
    }

    const identity = await authenticateDiscordUser(code);
    console.log("[speaking-debug] authenticateDiscordUser identity:", identity ? { ...identity, access_token: identity.access_token ? "(present)" : identity.access_token } : identity);
    if (!identity) {
      identityPromise = null;
      return null;
    }

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