const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { router: authRouter, SESSION_SECRET, COOKIE_NAME } = require('./auth');
const jwt = require('jsonwebtoken');
const { createHostAuth } = require('./hostAuth');
const db = require('./db');
const supabase = require('./supabaseClient');
const { createRoomPersistence, ROOM_TTL_MS } = require('./roomPersistence');
const createSendRoomState = require('./roomSync');

// Environment Variables & Port Config
const PORT = process.env.PORT || 4001;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5180';
const allowedOrigins = FRONTEND_URL.split(',').map((origin) => origin.trim()).filter(Boolean);
const isAllowedOrigin = (origin) => !origin || allowedOrigins.includes(origin);

// How long a disconnected player's team membership is held before we treat
// it as a real leave. Socket.IO fires 'disconnect' on tab-blur, brief
// network drops, and page refreshes — all of which reconnect within a
// second or two. Without this grace window, a disconnect instantly wipes
// the team (if they were its last member), and the reconnect that follows
// a moment later can't find that team anymore and creates a fresh one at
// score 0 — the "team resurrection" bug.
const DISCONNECT_GRACE_MS = 5 * 60 * 1000;
const MAX_BOARD_PAYLOAD_BYTES = 1_000_000;
const MAX_ROOM_CODE_LENGTH = 8;
const MAX_TEAM_NAME_LENGTH = 24;

// 1. Initialize Express App
const app = express();

// Trust proxy so secure cookies work properly through Cloudflare Tunnels
app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(cors({
  origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
  credentials: true,
}));
app.use(cookieParser());

const mediaRouter = require('./media');

// Mount Auth & API routes
app.use('/api/auth', authRouter);
app.use('/api/boards', require('./boards'));
app.use('/api/media', mediaRouter);
app.use('/api/shop', require('./shop'));

// =========================================================================
// YouTube IFrame API proxy — Discord Activities lock script-src to 'self',
// so loading https://www.youtube.com/iframe_api directly is always blocked.
// This route fetches the script through our own origin (same-origin = OK).
// The response is cached in memory for 1 hour to avoid hammering YouTube.
// =========================================================================
let ytApiCache = { body: null, fetchedAt: 0 };
const YT_API_CACHE_MS = 60 * 60 * 1000; // 1 hour

app.get('/api/youtube-iframe-api.js', async (_req, res) => {
  try {
    const now = Date.now();
    if (!ytApiCache.body || now - ytApiCache.fetchedAt > YT_API_CACHE_MS) {
      const resp = await fetch('https://www.youtube.com/iframe_api');
      if (!resp.ok) {
        return res.status(502).send('Failed to fetch YouTube IFrame API');
      }
      const rawText = await resp.text();
      
      // Rewrite any hardcoded widgetapi URL (from s.ytimg.com or www.youtube.com)
      // to go through our same-origin proxy route.
      const widgetApiRegex = /https?:\/\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_\-\/.]+\/www-widgetapi\.js/g;
      const modifiedText = rawText.replace(widgetApiRegex, (match) => {
        return `/api/youtube-widgetapi.js?url=${encodeURIComponent(match)}`;
      });

      ytApiCache = { body: modifiedText, fetchedAt: now };
    }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(ytApiCache.body);
  } catch (err) {
    console.error('[YouTube API proxy] error:', err);
    return res.status(500).send('Internal error proxying YouTube IFrame API');
  }
});

app.get('/api/youtube-widgetapi.js', async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).send('Missing url query parameter');
  }

  // Validate the URL to prevent SSRF (allow s.ytimg.com and youtube.com)
  const isAllowedHost = url.startsWith('https://s.ytimg.com/') || 
                       url.startsWith('https://www.youtube.com/') || 
                       url.startsWith('https://youtube.com/');
  if (!isAllowedHost) {
    return res.status(400).send('Invalid url');
  }

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      return res.status(502).send('Failed to fetch YouTube widgetapi script');
    }
    const body = await resp.text();
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    return res.send(body);
  } catch (err) {
    console.error('[YouTube widgetapi proxy] error:', err);
    return res.status(500).send('Internal error proxying YouTube widgetapi');
  }
});

// Initialize Socket.io Server
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Shared in-memory state for the browser host and player views.
const gameRooms = new Map();
const invalidatedRoomCodes = new Set();

// How often the empty-room sweep below runs. Doesn't need to be frequent —
// this is just memory hygiene, not anything time-sensitive to a live game.
const ROOM_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Rooms are never deleted anywhere else: a disconnect only ever removes
// the *player* from room.players (see the 'disconnect' handler and its
// DISCONNECT_GRACE_MS timeout below), never the room itself. Without this,
// every room anyone ever hosts stays in `gameRooms` for the lifetime of
// the process, even long after everyone's left. This sweep reclaims a
// room once it's genuinely abandoned.
//
// Checked against Socket.IO's own room membership (io.sockets.adapter.rooms),
// not room.players — room.players only ever gets entries from joinAsPlayer,
// so a host who's alone building/editing a board (no one's called
// joinAsPlayer yet) has no roster entry at all. Checking room.players here
// would treat that as "empty" and delete the room, board and all, out from
// under an actively-connected host. Checking actual socket presence instead
// covers the host (and any spectator) the same way it covers players.
const roomLastSeen = new Map(); // roomCode -> last time a socket was seen in it
function sweepEmptyRooms() {
  const now = Date.now();
  for (const [roomCode, room] of gameRooms) {
    const socketsInRoom = io.sockets.adapter.rooms.get(roomCode);
    if (socketsInRoom && socketsInRoom.size > 0) { roomLastSeen.set(roomCode, now); continue; } // someone's still actually connected
    const hasPendingReconnect = room?.pendingRemovals && room.pendingRemovals.size > 0;
    if (hasPendingReconnect) continue;
    // An empty room is kept for ROOM_TTL_MS so a restart/refresh can resume
    // it (its state is also saved to Supabase by roomPersistence).
    if (!roomLastSeen.has(roomCode)) roomLastSeen.set(roomCode, now);
    if (now - roomLastSeen.get(roomCode) < ROOM_TTL_MS) continue;
    gameRooms.delete(roomCode);
    roomLastSeen.delete(roomCode);
  }
}

setInterval(sweepEmptyRooms, ROOM_SWEEP_INTERVAL_MS).unref();

const roomPersistence = createRoomPersistence({ supabase, gameRooms });

/* =========================================================================
   VOICE PRESENCE (roster + mute/deaf only — no bot audio connection)
   Discord's regular Gateway (GuildVoiceStates intent) tells us who's in a
   voice channel and their mute/deaf flags. That's all the bot needs to
   provide now — "who's speaking" comes client-side instead, straight from
   the Discord Activity SDK's own RPC events (see useSpeakingState.js), and
   useTeams.js always prefers that value over anything broadcast here. So
   there's no reason for the bot to join the channel's audio anymore; this
   is purely Gateway data, no @discordjs/voice, no self-muted connection.
   ========================================================================= */
// channelId -> Set of socketIds currently watching it (via watchVoiceChannel)
const watchersByChannel = new Map();

function buildVoiceMemberList(channelId) {
  const channel = client.channels.cache.get(channelId);
  if (!channel || !channel.isVoiceBased?.()) return [];
  return channel.members.map((member) => ({
    id: member.id,
    username: member.displayName || member.user.username,
    avatarUrl: member.displayAvatarURL({ extension: 'png', size: 64 }),
    // speaking is intentionally omitted here — the client merges its own
    // SDK-sourced speaking state on top of this feed (see useTeams.js) and
    // ignores whatever this field would say, so there's no point tracking
    // it server-side anymore.
    muted: !!(member.voice.mute || member.voice.selfMute),
    deafened: !!(member.voice.deaf || member.voice.selfDeaf),
  }));
}

function broadcastVoiceState(channelId) {
  const watchers = watchersByChannel.get(channelId);
  if (!watchers || watchers.size === 0) return;
  const list = buildVoiceMemberList(channelId);
  for (const socketId of watchers) {
    io.sockets.sockets.get(socketId)?.emit('voiceState', list);
  }
}

// 2. Initialize Discord Bot Client
const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// 3. Register Slash Commands & Activity Entry Point
async function registerCommands() { 
  if (!DISCORD_TOKEN || !CLIENT_ID) { 
    console.error('Error: DISCORD_TOKEN or CLIENT_ID is missing in environment variables.'); 
    return;
  }

  const commands = [
    {
      name: 'launch',
      description: 'Launch Jeopardy Activity',
      type: 4, // PRIMARY_ENTRY_POINT
      handler: 2, // DISCORD_LAUNCH_ACTIVITY
      integration_types: [0, 1], // Guild Install & User Install
      contexts: [0, 1, 2], // Servers, Bot DMs, Group DMs
    },
    {
      name: 'buzz',
      description: 'Buzz in for Jeopardy!',
    },
  ];

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN); 

  try {
    console.log('Registering application commands with Entry Point...'); 
    await rest.put( 
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
    console.log('Successfully registered Activity Entry Point command!'); 
  } catch (err) {
    console.error('Failed to register commands:', err); 
  }
}

// 4. Discord Bot Event Handlers
client.once('ready', async () => { 
  console.log(`Discord Bot online as ${client.user.tag}`); 
  await registerCommands(); 
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return; 

  if (interaction.commandName === 'buzz') { 
    await interaction.reply({ content: 'Buzzed in!', flags: 64 }); 
  }
});

// Mute/deafen toggles and channel join/leave don't fire the speaking
// start/end events above (those are audio-only) — this catches everything
// else so the facepile's muted/deafened badges and membership stay live.
client.on('voiceStateUpdate', (oldState, newState) => {
  if (oldState.channelId && watchersByChannel.has(oldState.channelId)) {
    broadcastVoiceState(oldState.channelId);
  }
  if (newState.channelId && newState.channelId !== oldState.channelId && watchersByChannel.has(newState.channelId)) {
    broadcastVoiceState(newState.channelId);
  }
});

/* =========================================================================
   TEAM CLEANUP
   Shared by both the "no stable identity" immediate-leave path and the
   grace-period timeout below. Only removes a departed player's Discord id
   from their team, and only drops the team entirely once nobody else
   still connected is on it — a team with another active player keeps its
   score exactly as-is.
   ========================================================================= */
function detachFromTeamIfAbandoned(roomCode, leaving) {
  const room = gameRooms.get(roomCode);
  if (!leaving?.teamId || !room?.board?.data?.teams) return;

  const stillConnected = room.players.some((p) => p.teamId === leaving.teamId);
  if (stillConnected) return;

  const team = room.board.data.teams.find((t) => t.id === leaving.teamId);
  if (!team) return;

  if (Array.isArray(team.discordUserIds) && leaving.discordUserId) {
    team.discordUserIds = team.discordUserIds.filter((id) => id !== leaving.discordUserId);
  }
  const stillHasMembers = Array.isArray(team.discordUserIds) && team.discordUserIds.length > 0;
  if (!stillHasMembers) {
    room.board.data.teams = room.board.data.teams.filter((t) => t.id !== leaving.teamId);
  }
  room.board.updatedAt = Date.now();
  gameRooms.set(roomCode, room);
  io.to(roomCode).emit('boardUpdate', room.board);
}

// The host re-announces its saved board after reconnecting. That snapshot can
// be older than the live player roster, so preserve the Discord memberships
// already known by the room instead of allowing the host snapshot to erase
// them. Board content remains host-owned; only live team membership is merged.
function mergeLivePlayerMemberships(boardData, players) {
  if (!Array.isArray(boardData?.teams) || !Array.isArray(players)) return;

  const teamsById = new Map(boardData.teams.map((team) => [team.id, team]));
  for (const player of players) {
    if (!player?.teamId || !player.discordUserId) continue;
    const team = teamsById.get(player.teamId);
    if (!team) continue;
    if (!Array.isArray(team.discordUserIds)) team.discordUserIds = [];
    if (!team.discordUserIds.includes(player.discordUserId)) {
      team.discordUserIds.push(player.discordUserId);
    }
  }
}

// Sentinel stored in room.controlDiscordUserId to mean "control is open —
// any connected player may pick", as opposed to null ("locked, host only")
// or an actual discordUserId ("assigned to that one player"). Deliberately
// not a value that could collide with a real Discord snowflake id.
const OPEN_CONTROL = '__OPEN__';

/* =========================================================================
   BOARD CONTROL (who gets to pick the next category/clue)
   Keyed by discordUserId, NOT socket.id — socket.id changes on every
   reconnect (tab refresh, brief network drop), so anything keyed on it
   reproduces the exact "team resurrection" class of bug: the rightful
   control holder reconnects, gets a new socket.id, and the server no
   longer recognizes them as the one who's allowed to pick.

   room.controlDiscordUserId: string | null
   - null means nobody has been assigned control yet (e.g. round just
     started, or the host hasn't handed the board to anyone) — selectClue
     is LOCKED in that case, not open. Only the host has a free pick until
     it's explicitly assigned via hostSetControl or a correct judgeAnswer.
   - OPEN_CONTROL means the host explicitly opened the board to everyone —
     see hostSetControl.
   ========================================================================= */
function emitControlState(roomCode, room) {
  io.to(roomCode).emit('controlChanged', { controlDiscordUserId: room.controlDiscordUserId ?? null });
}

// Best-effort clue lookup by catId + value across every round in the
// board — used only to feed prewarmDriveMedia below, so a miss here just
// means no prewarm happens (falls back to on-demand fetch), never breaks
// clue selection itself. Doesn't assume which round is "current"; scans
// all of them since that's cheap and avoids depending on the exact field
// name the board uses to track the active round.
function findClueMediaUrls(boardData, catId, value) {
  const rounds = boardData?.rounds || [];
  for (const round of rounds) {
    const cat = (round.categories || []).find((c) => c.id === catId);
    if (!cat) continue;
    const clue = cat.clues?.[value] ?? cat.clues?.[String(value)];
    if (clue) return [clue.mediaUrl, clue.answerMediaUrl].filter(Boolean);
  }
  return [];
}

/* =========================================================================
   SKILLS (type 'skill' in shop.js)
   Flow: a player UNLOCKS a skill by buying it in the shop (auto-equipped).
   During a game the host pulls the lever on the Randomizer's Power-ups tab
   (which calls `hostPowerDraw`); every
   connected, teamed player who has a skill equipped and hasn't been granted
   it yet rolls that skill's data.grantChance (default 5%). Only GRANTED skills
   can be fired (`useSkill`), once per player per room.

   Server-authoritative: ownership/equip state is read from SQLite (never
   trusted from the client). Scores are owned by the host client, so the server
   only validates and computes the per-team deltas, then broadcasts
   `skillUsed`; every client plays the cutscene and the HOST applies the deltas
   when it ends (same "host is the source of truth for scores" rule as
   everything else).

   room.skillsGranted: { [discordUserId]: string[] } — skill ids granted by a draw
   room.skillsUsed:    { [discordUserId]: string[] } — skill ids spent since last granted
                       (winning a skill again in a spin removes it from here)
   ========================================================================= */
const SKILL_DOMAIN_EXPANSION = 'skill_domain_expansion';
const DEFAULT_GRANT_CHANCE = 0.05; // used if a skill's data has no grantChance
const CLEAVE_PERCENT = 0.20;   // each opponent loses 20% of their score...
const CLEAVE_MAX_LOSS = 1000;   // ...capped at this many points
// Slightly longer than DomainExpansion.jsx's total runtime (~27s) so two
// skills can never overlap on screen.
const SKILL_ANIMATION_MS = 30 * 1000;

// Skills this user has equipped: [{ id, name, grantChance }]
function getEquippedSkills(userId) {
  try {
    return db
      .prepare(
        `SELECT i.id, i.name, i.data FROM player_inventory inv
         JOIN shop_items i ON i.id = inv.item_id
         WHERE inv.user_id = ? AND inv.equipped = 1 AND i.type = 'skill'`
      )
      .all(userId)
      .map((row) => {
        let chance = DEFAULT_GRANT_CHANCE;
        try {
          const n = Number(JSON.parse(row.data || '{}').grantChance);
          if (Number.isFinite(n)) chance = Math.min(1, Math.max(0, n));
        } catch (_) { /* keep default */ }
        return { id: row.id, name: row.name, grantChance: chance };
      });
  } catch (err) {
    console.error('getEquippedSkills failed:', err.message);
    return [];
  }
}

/* ---- Per-player privacy for power-ups -------------------------------------
   Only the host may see everyone's power-ups. Players receive just their own
   entry of skillsGranted / powerupsGranted / randomizer.playerPowerups. */
function ownEntry(map, uid) {
  return uid && map && map[uid] ? { [uid]: map[uid] } : {};
}
function playerOfSocket(room, socketId) {
  return (room?.players || []).find((p) => p.socketId === socketId) || null;
}
function grantsFor(room, socket) {
  const skills = room?.skillsGranted || {};
  const items = room?.powerupsGranted || {};
  if (socket.isHost) return { skills, items };
  const uid = playerOfSocket(room, socket.id)?.discordUserId;
  return { skills: ownEntry(skills, uid), items: ownEntry(items, uid) };
}
function randomizerFor(room, socket) {
  const r = room?.randomizer;
  if (!r) return null;
  if (socket.isHost || !r.playerPowerups) return r;
  const uid = playerOfSocket(room, socket.id)?.discordUserId;
  return { ...r, playerPowerups: ownEntry(r.playerPowerups, uid) };
}
function sendGrantsTo(socket, room) {
  const g = grantsFor(room, socket);
  socket.emit('skillsGrantedUpdate', g.skills);
  socket.emit('powerupsGrantedUpdate', g.items);
  sendPowerupStateTo(socket, room);
}
function broadcastGrants(roomCode, room) {
  const players = (room.players || []).filter((p) => p.socketId);
  for (const p of players) {
    io.to(p.socketId).emit('skillsGrantedUpdate', ownEntry(room.skillsGranted, p.discordUserId));
    io.to(p.socketId).emit('powerupsGrantedUpdate', ownEntry(room.powerupsGranted, p.discordUserId));
  }
  const ids = players.map((p) => p.socketId);
  io.to(roomCode).except(ids).emit('skillsGrantedUpdate', room.skillsGranted || {});
  io.to(roomCode).except(ids).emit('powerupsGrantedUpdate', room.powerupsGranted || {});
}

/* =========================================================================
   POWER-UPS (the six spin items: 2x Points, Shield, Steal, Freeze, Hint,
   Re-Buzz). Handed out by the host's Power-ups spin (room.powerupsGranted,
   { [discordUserId]: label[] }). A player activates one with `usePowerup` —
   during a clue OR on the board (Domain Expansion is the only thing that is
   blocked mid-clue). Each activation consumes one copy of the label.

   Server-authoritative; scores stay host-owned, so:
   - 2x Points / Shield become "armed" entries (room.armedPowerups). The host
     client reads them when it judges an answer, applies the effect to the
     score delta and reports back with `hostConsumeArmed`.
   - Steal moves board control to the caster.
   - Freeze locks a target team out of the buzzer for the current clue (or the
     next one if no clue is open). room.frozenTeams: { [teamId]: { live } }
   - Hint privately tells the caster the shape of the answer.
   - Re-Buzz puts the caster at the front of the buzz queue.
   ========================================================================= */
const POWERUP_KINDS = {
  '2x Points': 'double',
  'Shield': 'shield',
  'Steal': 'steal',
  'Freeze': 'freeze',
  'Hint': 'hint',
  'Re-Buzz': 'rebuzz',
};

function currentRound(room) {
  const data = room?.board?.data;
  return data?.rounds?.[data.currentRound] || data?.rounds?.[0] || null;
}

function findActiveClue(room) {
  const ac = room?.activeClue;
  if (!ac) return null;
  const cat = (currentRound(room)?.categories || []).find((c) => c.id === ac.catId);
  return cat?.clues?.[ac.value] ?? cat?.clues?.[String(ac.value)] ?? null;
}

// "The Eiffel Tower" -> "T__ E_____ T____" (first letter of each word only).
function buildAnswerHint(answer) {
  const text = String(answer || '').replace(/<[^>]*>/g, '').trim();
  if (!text) return null;
  return text
    .split(/\s+/)
    .map((w) => {
      let shown = false;
      return w
        .split('')
        .map((ch) => {
          if (!/[\p{L}\p{N}]/u.test(ch)) return ch;
          if (!shown) { shown = true; return ch; }
          return '_';
        })
        .join('');
    })
    .join('  ');
}

function publicArmed(room) {
  return (room.armedPowerups || []).map((a) => ({
    id: a.id, kind: a.kind, label: a.label, teamId: a.teamId, username: a.username,
  }));
}
function publicFrozen(room) {
  const out = {};
  for (const [teamId, f] of Object.entries(room.frozenTeams || {})) out[teamId] = { live: !!f.live };
  return out;
}
function broadcastPowerupState(roomCode, room) {
  io.to(roomCode).emit('powerupsArmedUpdate', publicArmed(room));
  io.to(roomCode).emit('frozenTeamsUpdate', publicFrozen(room));
}
function sendPowerupStateTo(socket, room) {
  socket.emit('powerupsArmedUpdate', publicArmed(room || {}));
  socket.emit('frozenTeamsUpdate', publicFrozen(room || {}));
}
function teamOfPlayer(room, discordUserId) {
  return (room.players || []).find((p) => p.discordUserId === discordUserId)?.teamId || null;
}

function hasEquippedSkill(userId, skillId) {
  try {
    const row = db
      .prepare(
        `SELECT 1 FROM player_inventory inv
         JOIN shop_items i ON i.id = inv.item_id
         WHERE inv.user_id = ? AND inv.item_id = ? AND inv.equipped = 1 AND i.type = 'skill'`
      )
      .get(userId, skillId);
    return !!row;
  } catch (err) {
    console.error('hasEquippedSkill failed:', err.message);
    return false;
  }
}

// 5. Unified Socket.io Real-time Game Coordination (handlers live in ./handlers)
const registerHandlers = require('./handlers');
const sendRoomState = createSendRoomState({ randomizerFor, sendGrantsTo });
// Who may become host of a room: the owner/editor of the board whose invite
// code is the room code (see hostAuth.js). ALLOW_UNVERIFIED_HOST=1 restores the
// old self-declared behaviour for local debugging only.
const hostAuth = createHostAuth({
  db,
  jwt,
  secret: SESSION_SECRET,
  cookieName: COOKIE_NAME,
  allowUnverified: process.env.ALLOW_UNVERIFIED_HOST === '1',
});
if (process.env.ALLOW_UNVERIFIED_HOST === '1') {
  console.warn('[hostAuth] ALLOW_UNVERIFIED_HOST=1: ANY client can claim host. Do not use in production.');
}
const ctx = {
  CLEAVE_MAX_LOSS,
  CLEAVE_PERCENT,
  DISCONNECT_GRACE_MS,
  MAX_BOARD_PAYLOAD_BYTES,
  MAX_ROOM_CODE_LENGTH,
  MAX_TEAM_NAME_LENGTH,
  OPEN_CONTROL,
  POWERUP_KINDS,
  SKILL_ANIMATION_MS,
  SKILL_DOMAIN_EXPANSION,
  broadcastGrants,
  broadcastPowerupState,
  buildAnswerHint,
  buildVoiceMemberList,
  currentRound,
  detachFromTeamIfAbandoned,
  emitControlState,
  findActiveClue,
  findClueMediaUrls,
  gameRooms,
  getEquippedSkills,
  hostAuth,
  hasEquippedSkill,
  invalidatedRoomCodes,
  io,
  mediaRouter,
  mergeLivePlayerMemberships,
  publicFrozen,
  randomizerFor,
  roomPersistence,
  sendGrantsTo,
  sendRoomState,
  teamOfPlayer,
  watchersByChannel,
};
io.on('connection', (socket) => registerHandlers(socket, ctx));

// 6. Start HTTP Server and Login to Discord
// Restore any saved rooms first (bounded so a slow Supabase can't block startup).
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
withTimeout(roomPersistence.hydrate(), 5000)
  .catch(() => {})
  .finally(() => {
    roomPersistence.start();
    server.listen(PORT, () => {
      console.log(`Socket & Bot server running on http://localhost:${PORT}`);
    });
  });

// Save once more on shutdown so the last few seconds of play aren't lost.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    withTimeout(roomPersistence.flush(), 3000).finally(() => process.exit(0));
  });
}

if (DISCORD_TOKEN) {
  client.login(DISCORD_TOKEN);
} else {
  console.warn('Warning: DISCORD_TOKEN not found. Skipping Discord client login.');
}