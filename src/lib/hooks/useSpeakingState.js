// src/lib/hooks/useSpeakingState.js
import { useEffect, useState, useRef } from "react";
import { discordSdk, activityChannelId, getDiscordIdentity } from "../../discordSdk";

/*
 * Live "who's talking right now" state, sourced directly from the Discord
 * Activity SDK's own RPC events (SPEAKING_START / SPEAKING_STOP), not from
 * the bot server. Every client running the Activity in this voice channel
 * receives these events independently — host, player, and spectator views
 * all get the same signal for free, no socket relay needed.
 *
 * Requires the `rpc.voice.read` scope (see discordSdk.js) to be granted AND
 * approved for this app in the Discord Developer Portal, or subscribe()
 * below will silently never fire.
 *
 * Returns a Set<string> of Discord user IDs currently speaking. Merge this
 * into your discordMembers list as `speaking: speakingIds.has(m.id)` before
 * passing members down to TeamCard.
 */
export function useSpeakingState() {
  const [speakingIds, setSpeakingIds] = useState(() => new Set());
  const subscribedRef = useRef(false);

  useEffect(() => {
    if (!discordSdk || !activityChannelId) {
      // Standalone browser tab, or Activity SDK unavailable/unauthorized —
      // nothing to subscribe to. Leave speakingIds empty; TeamCard just
      // won't show the glow, same as today.
      console.log("[speaking-debug] skipped: discordSdk =", !!discordSdk, "activityChannelId =", activityChannelId);
      return;
    }

    let cancelled = false;

    const handleSpeakingStart = ({ user_id }) => {
      console.log("[speaking-debug] SPEAKING_START received for", user_id);
      setSpeakingIds((prev) => {
        if (prev.has(user_id)) return prev;
        const next = new Set(prev);
        next.add(user_id);
        return next;
      });
    };

    const handleSpeakingStop = ({ user_id }) => {
      console.log("[speaking-debug] SPEAKING_STOP received for", user_id);
      setSpeakingIds((prev) => {
        if (!prev.has(user_id)) return prev;
        const next = new Set(prev);
        next.delete(user_id);
        return next;
      });
    };

    (async () => {
      try {
        // getDiscordIdentity() is cached page-lifetime (see discordSdk.js)
        // and is what actually calls discordSdk.commands.authenticate()
        // under the hood. Awaiting it here — even if some other component
        // already triggered it — guarantees subscribe() below always runs
        // against an authenticated RPC session instead of racing it. If
        // authenticate() never happens first, subscribe() can resolve
        // without error yet never receive a single event.
        const identity = await getDiscordIdentity();
        console.log("[speaking-debug] getDiscordIdentity resolved:", identity);

        // TEMP CONTROL TEST: VOICE_STATE_UPDATE uses the exact same scope
        // and channel arg as SPEAKING_START/STOP, but fires on ANY mute/
        // deafen/volume toggle — much easier to trigger on demand than
        // "am I talking loud enough." If toggling your mute button in
        // Discord's own UI logs nothing here, the subscription mechanism
        // itself isn't receiving voice events at all (wrong channel_id,
        // RPC session issue, etc) — not something specific to speaking
        // detection. Remove this block once speaking is confirmed working.
        await discordSdk.subscribe(
          "VOICE_STATE_UPDATE",
          (data) => console.log("[speaking-debug] VOICE_STATE_UPDATE received:", data),
          { channel_id: activityChannelId }
        );
        console.log("[speaking-debug] VOICE_STATE_UPDATE subscribed OK — now toggle your mute button in Discord and check for a log line");

        await discordSdk.subscribe(
          "SPEAKING_START",
          handleSpeakingStart,
          { channel_id: activityChannelId }
        );
        await discordSdk.subscribe(
          "SPEAKING_STOP",
          handleSpeakingStop,
          { channel_id: activityChannelId }
        );
        if (!cancelled) subscribedRef.current = true;
        console.log("[speaking-debug] subscribed OK for channel", activityChannelId);
      } catch (err) {
        // Most likely cause: rpc.voice.read wasn't granted for this app
        // yet, or the identity/authenticate flow above failed. Fail
        // quietly — no glow, rather than crashing the board.
        console.warn("[speaking-debug] Speaking-state subscribe failed:", err.message, err);
      }
    })();

    return () => {
      cancelled = true;
      if (subscribedRef.current && discordSdk) {
        discordSdk
          .unsubscribe("SPEAKING_START", handleSpeakingStart, { channel_id: activityChannelId })
          .catch(() => {});
        discordSdk
          .unsubscribe("SPEAKING_STOP", handleSpeakingStop, { channel_id: activityChannelId })
          .catch(() => {});
        subscribedRef.current = false;
      }
    };
  }, []);

  return speakingIds;
}