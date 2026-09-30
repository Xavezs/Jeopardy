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
- **Shop and coins** — players earn coins from correct answers and podium
  finishes, then spend them in the shop on cosmetics (such as buzzer sounds)
  and skills.
- **Power-ups and skills** — the host runs a Power-ups spin in the Randomizer;
  players can win one-shot power-ups (2x Points, Shield, Steal, Freeze, Hint,
  Re-Buzz) and, if they own it, the **Domain Expansion** skill.
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
  components/DomainExpansion.jsx  Domain Expansion cutscene (styles: styles/domain-expansion.css)
  components/SkillOverlay.jsx     Plays the cutscene for whichever skill is active
  lib/powerups.js             Client-side power-up catalog and usage rules
  lib/hooks/                  Persistence and real-time synchronization hooks
  lib/storage/                Session, media, and local storage helpers
  styles/                     Board and player styles
discord-bot/
  bot-server.js               Express and Socket.IO server plus Discord bot
  auth.js                     Discord Activity authentication
  boards.js                   Board API routes
  media.js                    Media upload/proxy routes
  shop.js                     Shop, wallet, and loadout API
  give-skill.js               CLI helper to grant a skill to a Discord user
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

## Shop, power-ups, and skills

**Coins.** Players earn 100 coins per correct answer in a game, plus a bonus
for finishing on the podium (+200 for 1st, +100 for 2nd). Coins are spent in
the shop, which requires a signed-in Discord user.

**Power-ups.** During a game the host opens the Randomizer's Power-ups tab and
runs a spin. Winners receive one-shot power-ups that they activate from the
player view. Power-ups cannot be used during Final Jeopardy.

| Power-up  | Effect                                                    |
| --------- | --------------------------------------------------------- |
| 2x Points | Your team's next correct answer scores double.            |
| Shield    | Cancels your team's next wrong-answer penalty.            |
| Steal     | Take board control and pick the next clue.                |
| Freeze    | Lock another team out of buzzing for this clue or the next. |
| Hint      | Privately reveals the first letter of each answer word.   |
| Re-Buzz   | Jump to the front of the buzz queue.                      |

Hint and Re-Buzz only work while a clue is open (Re-Buzz also needs a live
buzzer).

**Skills.** Skills are bought in the shop and auto-equipped. Owning one does
not let a player fire it: on each Power-ups spin, every player with the skill
equipped rolls its `grantChance`, and only a granted skill can be used, once
per game.

**Domain Expansion** is the current skill. When cast, every client plays a
full-screen cutscene, and every other team with a positive score loses 20% of
its score (capped at 1000). The server computes the deltas; the host applies
them when the cutscene ends, since the host owns scores.

The cutscene opens as a circle from the caster's team card, then plays a
blood-moon title with layered smoke and a letterbox, a white flash, a slash
barrage with a rising shrine, and finally a scar and damage number over each
hit team's card. Pacing lives in the `TIMING` object and the title text in
`CONTENT`, both at the top of `src/components/DomainExpansion.jsx`. If you
change `riseMs`, update `--de-rise` in `src/styles/domain-expansion.css` to
match. Team cards must keep their `data-team-id` attribute, which the cutscene
uses to position its effects.

To grant a skill to a user for testing:

```powershell
cd discord-bot
node give-skill.js <discordUserId> [itemId]
```

`itemId` defaults to `skill_domain_expansion`. Shop items and prices are seeded
in `discord-bot/db.js`.

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