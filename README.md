# Jeopardy! Discord Activity

A real-time, customizable Jeopardy-style trivia game designed to run as a
Discord Activity. One person hosts the board while friends join as players
using a room code. The host controls the game and players see board, clue,
wager, buzzer, and score updates in real time.

## Features

- **Host and player roles** — hosts manage the board; players join with a room
  code and can select clues when control is assigned to them.
- **Customizable boards** — edit categories, point values, clues, answers, and
  media.
- **Rich clue media** — support images, audio, video, YouTube, SoundCloud, and
  Google Drive media where configured.
- **Live multiplayer sync** — synchronize board state, active clues, category
  reveals, music, randomizer state, buzzer queues, wagers, and Final Jeopardy
  across connected clients.
- **Daily Doubles** — player wagers, configurable wager rules, and host
  judging.
- **Final Jeopardy** — category, wager, clue, answer, reveal, standings, and
  undo-last-judgment flow.
- **Teams and Discord identity** — team scores, Discord usernames, avatars,
  speaking state, and player statistics.
- **Game-show presentation** — themed styling, sound effects, background music,
  timers, animations, and standings celebration.
- **Persistence** — board/session data is saved locally and can use the
  configured backend for shared room state and media.

## Project structure

```text
src/
  App.jsx                     Host/player entry and role routing
  JeopardyBoard.jsx           Host board and game orchestration
  components/                 Board, player, clue, media, and modal UI
  lib/hooks/                  Persistence and real-time synchronization hooks
  lib/storage/                Session, media, and local storage helpers
  styles/                     Board and player styles
discord-bot/
  bot-server.js               Express and Socket.IO server plus Discord bot
  auth.js                     Discord Activity authentication
  boards.js                   Board API routes
  media.js                    Media upload/proxy routes
  db.js                       Local SQLite persistence
vite.config.js                Vite development server and API proxy
start.bat                     Windows launcher for the local services
```

## Requirements

- Node.js 18 or newer
- npm
- A Discord application configured as an Activity
- Cloudflare `cloudflared` when testing the Activity through a public tunnel
- Supabase and Google Drive configuration only if using those media features

## Local development

1. Install frontend dependencies:

   ```powershell
   npm install
   ```

2. Install backend dependencies:

   ```powershell
   cd discord-bot
   npm install
   cd ..
   ```

3. Create the environment files described below.

4. Start the frontend, bot/API server, and Cloudflare tunnel:

   ```powershell
   npm run jeopardy
   ```

   On Windows, `start.bat` can also be used to launch the same services in
   separate terminals.

The Vite development server runs on `http://localhost:5173` and proxies API
and Socket.IO requests to the bot server on port `4001`.

## Environment variables

Frontend variables belong in the root `.env` file:

```text
VITE_DISCORD_CLIENT_ID=
VITE_API_URL=
VITE_BOT_SERVER_URL=
VITE_SUPABASE_URL=
VITE_SUPABASE_BUCKET=jeopardy-media
```

Backend variables belong in `discord-bot/.env`:

```text
PORT=4001
DISCORD_TOKEN=
CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=
SESSION_SECRET=
FRONTEND_URL=http://localhost:5173
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_BUCKET=jeopardy-media
GOOGLE_DRIVE_API_KEY=
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=
```

Do not commit either `.env` file, `service-account.json`, or the local
`jeopardy.db` file. They are ignored by Git.

## Playing a game

1. Start the services and open the Activity.
2. Choose **Host** and sign in if prompted.
3. Edit the board, add teams, and share the generated room code.
4. Friends choose **Player**, enter the room code, and join.
5. Assign or pass clue control, open clues, manage the buzzer, judge answers,
   and advance through Daily Double and Final Jeopardy.

For local browser testing outside Discord, use the development fallback
supported by `src/discordSdk.js`.

## Production notes

- The Activity must be served over HTTPS and configured with Discord URL
  mappings.
- The backend must be reachable by the Activity and Socket.IO clients.
- Keep Discord and Supabase secrets on the server; only public client
  configuration belongs in the frontend environment.
- YouTube playback uses the backend proxy because Discord Activity CSP rules
  prevent direct loading of the YouTube IFrame API.

## Build

Create a production frontend build with:

```powershell
npm run build
```

## Tests

Run the production-logic tests with:

```powershell
npm test
```

The current tests cover the Final Jeopardy phase machine, invalid phase
transitions, batch scoring, wager overrides, and undo behavior.
