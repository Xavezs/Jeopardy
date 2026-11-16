import { isDiscordActivity } from "./environment";
import { getDiscordIdentity } from "../discordSdk";
import { ensureWebSession } from "./webSession";

// One entry point for "who is this player?" in both environments.
// Discord Activity: verified Discord identity. Browser: existing login or a server-issued guest session.
export async function getIdentity() {
  // Returns the Activity identity, or the ?fakePlayer test identity outside Discord; null otherwise.
  const discord = await getDiscordIdentity();
  if (discord) return { ...discord, platform: discord.platform || (isDiscordActivity ? "activity" : "web") };

  // Inside Discord, never fall back to a guest: a failed Discord auth must stay a failure.
  if (isDiscordActivity) return null;
  return ensureWebSession();
}
