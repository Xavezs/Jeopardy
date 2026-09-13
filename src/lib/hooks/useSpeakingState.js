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
      return;
    }

    let cancelled = false;

    const handleSpeakingStart = ({ user_id }) => {
      setSpeakingIds((prev) => {
        if (prev.has(user_id)) return prev;
        const next = new Set(prev);
        next.add(user_id);
        return next;
      });
    };

    const handleSpeakingStop = ({ user_id }) => {
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
        await getDiscordIdentity();

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
      } catch (err) {
        // Most likely cause: rpc.voice.read wasn't granted for this app
        // yet, or the identity/authenticate flow above failed. Fail
        // quietly — no glow, rather than crashing the board.
        console.warn("Speaking-state subscription failed:", err.message);
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