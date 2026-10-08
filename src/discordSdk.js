import { DiscordSDK } from '@discord/embedded-app-sdk';

const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID;

const hasFrameId = new URLSearchParams(window.location.search).has('frame_id');

function getFakePlayerIdentity() {
  const params = new URLSearchParams(window.location.search);
  if (hasFrameId || !params.has('fakePlayer')) return null;

  const storageKey = 'jeopardy_fake_player_identity';
  const cached = sessionStorage.getItem(storageKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
    }
  }

  const name = params.get('name') || `Test Player ${Math.floor(Math.random() * 1000)}`;
  const identity = {
    id: `fake-${Math.random().toString(36).slice(2, 10)}`,
    username: name,
    avatarUrl: null,
  };
  sessionStorage.setItem(storageKey, JSON.stringify(identity));
  console.warn('[discordSdk] Using FAKE player identity for testing:', identity);
  return identity;
}

function createSdkInstance() {
  if (!(clientId && hasFrameId)) return null;
  try {
    return new DiscordSDK(clientId);
  } catch (err) {
    console.warn("DiscordSDK construction failed, continuing without it:", err.message);
    return null;
  }
}

export let discordSdk = createSdkInstance();

export const activityChannelId = hasFrameId
  ? new URLSearchParams(window.location.search).get('channel_id')
  : null;

let setupPromise = null;
const DISCORD_COMMAND_TIMEOUT_MS = 15000;

function withDiscordTimeout(promise, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Discord ${label} timeout`)), DISCORD_COMMAND_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

let readyPromise = null;
function getReadyPromise() {
  if (!readyPromise) {
    readyPromise = discordSdk.ready().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

export function resetDiscordSdk() {
  try {
    discordSdk?.close(1000, "Client requested reconnect");
  } catch (err) {
    console.warn("discordSdk.close() failed, continuing with reset anyway:", err.message);
  }
  setupPromise = null;
  readyPromise = null;
  identityPromise = null;
  discordSdk = createSdkInstance();
}

export async function setupDiscordSdk() {
  if (!discordSdk) {
    console.warn("Discord SDK skipped: no frame_id (not running inside Discord) or VITE_DISCORD_CLIENT_ID is missing.");
    return null;
  }

  if (setupPromise) return setupPromise;

  setupPromise = (async () => {
    try {
      await withDiscordTimeout(getReadyPromise(), "ready handshake");
      console.log("Discord SDK is ready!");

      const { code } = await withDiscordTimeout(discordSdk.commands.authorize({
        client_id: clientId,
        response_type: 'code',
        state: '',
        prompt: 'none',
        scope: ['identify', 'rpc.voice.read'],
      }), "authorization");

      return code;
    } catch (err) {
      console.warn("Discord SDK setup bypassed or failed (likely running in standalone browser mode):", err.message);
      return null;
    } finally {
      setupPromise = null;
    }
  })();

  return setupPromise;
}

export async function authenticateDiscordUser(code) {
  if (!code) return null;

  try {
    const response = await fetch("/api/auth/token", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(discordSdk ? { "x-discord-activity": "1" } : {}),
      },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`);
    const { user, access_token } = await response.json();
    return user ? { ...user, access_token } : null;
  } catch (err) {
    console.warn("Discord identity lookup failed (likely standalone browser mode):", err.message);
    return null;
  }
}

let identityPromise = null;

export function getDiscordIdentity() {
  if (identityPromise) return identityPromise;

  const fakeIdentity = getFakePlayerIdentity();
  if (fakeIdentity) {
    identityPromise = Promise.resolve(fakeIdentity);
    return identityPromise;
  }

  identityPromise = (async () => {
    const code = await setupDiscordSdk();
    if (!code) {
      identityPromise = null;
      return null;
    }

    const identity = await authenticateDiscordUser(code);
    if (!identity) {
      identityPromise = null;
      return null;
    }

    const { access_token, ...user } = identity;

    if (discordSdk && access_token) {
      try {
        await discordSdk.commands.authenticate({ access_token });
      } catch (err) {
        console.warn("Discord SDK authentication failed:", err.message);
      }
    } else {
      console.warn("Discord SDK authentication skipped: missing SDK or access token.");
    }

    return user;
  })();

  return identityPromise;
}