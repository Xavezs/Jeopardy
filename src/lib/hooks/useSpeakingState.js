import { useEffect, useState, useRef } from "react";
import { discordSdk, activityChannelId, getDiscordIdentity } from "../../discordSdk";

export function useSpeakingState() {
  const [speakingIds, setSpeakingIds] = useState(() => new Set());
  const subscribedRef = useRef(false);

  useEffect(() => {
    if (!discordSdk || !activityChannelId) {
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