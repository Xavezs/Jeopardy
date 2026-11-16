// Where is this app running? Used only to pick the UI/auth flow. It is NOT a security check:
// the server decides what each session may do, based on its signed token.
const params = new URLSearchParams(window.location.search);

// Discord loads Activities with frame_id/instance_id in the query string (preserved on navigation, see buildPlayPath in App.jsx).
export const isDiscordActivity = params.has("frame_id");
export const isWeb = !isDiscordActivity;
export const environment = isDiscordActivity ? "discord" : "web";
