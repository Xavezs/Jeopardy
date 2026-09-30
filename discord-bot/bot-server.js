const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { router: authRouter } = require('./auth');
const db = require('./db');

// Environment Variables & Port Config
const PORT = process.env.PORT || 4001;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
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
function sweepEmptyRooms() {
  for (const [roomCode, room] of gameRooms) {
    const socketsInRoom = io.sockets.adapter.rooms.get(roomCode);
    if (socketsInRoom && socketsInRoom.size > 0) continue; // someone's still actually connected
    const hasPendingReconnect = room?.pendingRemovals && room.pendingRemovals.size > 0;
    if (hasPendingReconnect) continue;
    gameRooms.delete(roomCode);
  }
}

setInterval(sweepEmptyRooms, ROOM_SWEEP_INTERVAL_MS).unref();

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
   room.skillsUsed:    { [discordUserId]: string[] } — skill ids already spent
   ========================================================================= */
const SKILL_DOMAIN_EXPANSION = 'skill_domain_expansion';
const DEFAULT_GRANT_CHANCE = 0.05; // used if a skill's data has no grantChance
const CLEAVE_PERCENT = 0.20;   // each opponent loses 10% of their score...
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

// 5. Unified Socket.io Real-time Game Coordination
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('joinRoom', (payload) => {
    const rawRoomCode = typeof payload === 'string' ? payload : payload?.roomCode;
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;
    if (invalidatedRoomCodes.has(roomCode)) {
      socket.emit('errorMsg', 'This room code has been replaced.');
      return;
    }

    // Only ever PROMOTE to host here. Other hooks re-emit joinRoom with a plain
    // room-code string, which must not wipe the host flag set by the host join.
    if (payload && typeof payload === 'object' && payload.role === 'host') {
      socket.isHost = true;
    }
    socket.join(roomCode);
    socket.gameRoomCode = roomCode;

    const room = gameRooms.get(roomCode);
    if (room?.board) socket.emit('boardUpdate', room.board);
    if (room?.buzzer) socket.emit('buzzerState', room.buzzer);
    if (room?.activeClue !== undefined) socket.emit('activeClueUpdate', room.activeClue);
    if (room?.revealedCats) socket.emit('revealedCatsUpdate', room.revealedCats);
    if (room?.bgm !== undefined) socket.emit('bgmUpdate', room.bgm);
    if (room?.randomizer) socket.emit('randomizerUpdate', randomizerFor(room, socket));
    if (room?.players) socket.emit('playersUpdate', room.players);
    if (room) socket.emit('controlChanged', { controlDiscordUserId: room.controlDiscordUserId ?? null });
    if (room?.playerStats) socket.emit('statsUpdate', room.playerStats);
    socket.emit('skillsUsedUpdate', room?.skillsUsed || {});
    sendGrantsTo(socket, room);
  });

  socket.on('rotateRoomCode', ({ oldRoomCode, newRoomCode }, ack) => {
    const reject = (message) => {
      if (typeof ack === 'function') ack({ ok: false, error: message });
    };
    if (!socket.isHost || typeof oldRoomCode !== 'string' || typeof newRoomCode !== 'string') {
      reject('Only the host can change the room code.');
      return;
    }
    const oldCode = oldRoomCode.trim().toUpperCase();
    const newCode = newRoomCode.trim().toUpperCase();
    if (!oldCode || !newCode || socket.gameRoomCode !== oldCode || gameRooms.has(newCode)) {
      reject('The live room is no longer available.');
      return;
    }

    const room = gameRooms.get(oldCode);
    if (!room) {
      reject('The live room is no longer available.');
      return;
    }
    invalidatedRoomCodes.add(oldCode);
    gameRooms.set(newCode, room);
    gameRooms.delete(oldCode);
    socket.leave(oldCode);
    socket.join(newCode);
    socket.gameRoomCode = newCode;
    io.to(oldCode).emit('roomCodeChanged', { roomCode: newCode });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('activeClueUpdate', ({ roomCode: rawRoomCode, activeClue }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    const room = gameRooms.get(roomCode) || {};
    const prevClue = room.activeClue;
    // Only counts as "picking a new clue" when catId/value actually
    // changes — activeClueUpdate also fires on every revealed/timer/
    // playback field change within the SAME clue, and re-prewarming on
    // those would just be wasted cache lookups (harmless, since
    // getDriveFile is cached, but pointless).
    const isNewClue =
      activeClue && (!prevClue || prevClue.catId !== activeClue.catId || prevClue.value !== activeClue.value);
    room.activeClue = activeClue || null;

    // Freeze lifecycle: a freeze cast between clues starts biting when the next
    // clue opens, and every freeze ends when the clue it covered closes.
    if (room.frozenTeams && Object.keys(room.frozenTeams).length) {
      let changed = false;
      if (isNewClue) {
        for (const f of Object.values(room.frozenTeams)) if (!f.live) { f.live = true; changed = true; }
      } else if (!activeClue) {
        for (const [teamId, f] of Object.entries(room.frozenTeams)) {
          if (f.live) { delete room.frozenTeams[teamId]; changed = true; }
        }
      }
      if (changed) io.to(roomCode).emit('frozenTeamsUpdate', publicFrozen(room));
    }

    gameRooms.set(roomCode, room);
    socket.to(roomCode).emit('activeClueUpdate', room.activeClue);

    // Host's own clue pick — selectClue (below) only covers player picks,
    // so this is the prewarm trigger for the far more common "host clicks
    // the board" path. Fires alongside the relay above rather than
    // blocking it.
    if (isNewClue) {
      const mediaUrls = findClueMediaUrls(room.board?.data, activeClue.catId, activeClue.value);
      mediaUrls.forEach((url) => mediaRouter.prewarmDriveMedia(url));
    }
  });

  // Player-initiated clue pick. Only the current control holder may open a
  // clue — validated server-side against their stable discordUserId, not
  // trusted from the client (client-side disabling alone can be bypassed by
  // emitting the event directly). If nobody holds control yet (start of a
  // round, or host hasn't assigned anyone), NO player may pick — that's a
  // deliberate flip from "unrestricted until assigned": leaving it open by
  // default let every player pick immediately on join, before the host had
  // a chance to hand control to anyone. The host still always has a free
  // pick (that path never goes through this handler at all — see
  // JeopardyBoard.jsx's inline board click), and can open the board up to a
  // specific player via the "Board control" dropdown (hostSetControl).
  //
  // Deliberately does NOT set room.activeClue itself. The host's local
  // clueEditor state (JeopardyBoard.jsx) is the single source of truth for
  // the actual clue session — reveal state, timer, media playback — all of
  // that only exists on the host's screen. Setting activeClue directly here
  // would show the clue to players while the host's own modal never opens,
  // leaving nobody able to run reveal/judge for it. Instead this just
  // relays "someone picked this cell" to the host, who opens their own
  // ClueModal in response (see JeopardyBoard.jsx's useControlSync
  // onClueSelected), which THEN publishes activeClue as normal.
  socket.on('selectClue', ({ roomCode: rawRoomCode, catId, value, discordUserId }) => {
    if (typeof rawRoomCode !== 'string' || !catId || value == null) return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    const room = gameRooms.get(roomCode);
    if (!room) return;

    const isOpen = room.controlDiscordUserId === OPEN_CONTROL;
    if (!isOpen) {
      // useControlSync keeps its own socket connection, separate from
      // whichever socket actually ran joinAsPlayer — so socket.id can't be
      // used to find "me" in room.players here anymore. Trust the
      // discordUserId the client sends instead (same as judgeAnswer /
      // hostSetControl already do), but still require it to belong to a
      // player actually registered in this room, so an arbitrary/spoofed
      // id can't claim someone else's turn.
      const isRegisteredPlayer =
        !!discordUserId && room.players?.some((p) => p.discordUserId === discordUserId);
      if (!room.controlDiscordUserId || !isRegisteredPlayer || discordUserId !== room.controlDiscordUserId) {
        socket.emit('errorMsg', 'Not your turn to pick a clue.');
        return;
      }
    }

    io.to(roomCode).emit('clueSelected', { catId, value });

    // Fire-and-forget: start fetching this clue's Drive attachment(s) now,
    // in parallel with the clueSelected broadcast above, instead of
    // waiting for the host's ClueModal to open and every player's
    // <video>/<audio> tag to request it independently. See
    // prewarmDriveMedia's own comment in media.js for the full reasoning.
    const mediaUrls = findClueMediaUrls(room.board?.data, catId, value);
    mediaUrls.forEach((url) => mediaRouter.prewarmDriveMedia(url));
  });

  // Player-submitted Daily Double wager. Same trust model as selectClue:
  // never take the client's word for whose turn it is, re-check against
  // room.controlDiscordUserId. Unlike selectClue, OPEN_CONTROL does NOT
  // bypass this — a wager belongs to one specific player, so "anyone can
  // pick" mode has no valid wagerer and must fall back to the host's
  // manual entry (see ClueModal.jsx). Deliberately does not clamp `amount`
  // against 2x the clue's value — the server has no notion of "which
  // clue/value is currently open" beyond the host's own local clueEditor
  // state, and the host's UI already applies that clamp identically for
  // both this path and its manual fallback (see ClueModal's maxWager).
  socket.on('submitWager', ({ roomCode: rawRoomCode, amount, discordUserId }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    const room = gameRooms.get(roomCode);
    if (!room) return;

    const isRegisteredPlayer =
      !!discordUserId && room.players?.some((p) => p.discordUserId === discordUserId);
    if (
      !room.controlDiscordUserId ||
      room.controlDiscordUserId === OPEN_CONTROL ||
      !isRegisteredPlayer ||
      discordUserId !== room.controlDiscordUserId
    ) {
      socket.emit('errorMsg', 'Not your wager to submit.');
      return;
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) return;

    io.to(roomCode).emit('wagerSubmitted', { discordUserId, amount: parsedAmount });
  });

  // Final Jeopardy wager — ALL players submit in PARALLEL (unlike Daily
  // Double's single control-holder wager above), so this does NOT gate on
  // room.controlDiscordUserId at all — just checks the sender is a
  // registered player in this room. The host resolves discordUserId ->
  // team (via useTeams' resolveTeamForDiscordUser) and clamps the amount
  // against that team's current score before writing it into
  // round.wagers — this handler is only the relay, same division of
  // responsibility selectClue/submitWager already use.
  socket.on('submitFinalWager', ({ roomCode: rawRoomCode, amount, discordUserId }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    const room = gameRooms.get(roomCode);
    if (!room) return;

    const isRegisteredPlayer =
      !!discordUserId && room.players?.some((p) => p.discordUserId === discordUserId);
    if (!isRegisteredPlayer) {
      socket.emit('errorMsg', 'Not registered in this room.');
      return;
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) return;

    io.to(roomCode).emit('finalWagerSubmitted', { discordUserId, amount: parsedAmount });
  });

  // Final Jeopardy answer — same parallel-submission trust model as the
  // wager above: any registered player may submit, no control-holder
  // gate, no "is it your turn" check.
  socket.on('submitFinalAnswer', ({ roomCode: rawRoomCode, answer, discordUserId }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    const room = gameRooms.get(roomCode);
    if (!room) return;

    const isRegisteredPlayer =
      !!discordUserId && room.players?.some((p) => p.discordUserId === discordUserId);
    if (!isRegisteredPlayer) {
      socket.emit('errorMsg', 'Not registered in this room.');
      return;
    }

    if (typeof answer !== 'string') return;

    io.to(roomCode).emit('finalAnswerSubmitted', { discordUserId, answer: answer.slice(0, 500) });
  });

  // Host (or whatever judges the answer) reports the outcome. Control only
  // moves on a correct answer, to whoever answered it — everything else
  // (wrong / nobody answered) leaves controlDiscordUserId exactly as-is, so
  // the same player keeps the board until someone actually gets one right.
  socket.on('judgeAnswer', ({ roomCode: rawRoomCode, discordUserId, correct }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    const room = gameRooms.get(roomCode);
    if (!room) return;

    // Track per-player correct/wrong counts for end-game stats, keyed by
    // discordUserId — same convention as team/control state, since
    // socket.id changes on every reconnect. judgeAnswer doesn't carry the
    // clue's point value, so this is a count of attempts, not a point
    // total; if a points-based stat is ever needed, the client will need
    // to start sending `value` alongside discordUserId/correct.
    if (discordUserId) {
      room.playerStats = room.playerStats || {};
      const stats = room.playerStats[discordUserId] || { correct: 0, wrong: 0 };
      if (correct) stats.correct += 1;
      else stats.wrong += 1;
      room.playerStats[discordUserId] = stats;
      gameRooms.set(roomCode, room);
      io.to(roomCode).emit('statsUpdate', room.playerStats);
    }

    if (correct && discordUserId) {
      room.controlDiscordUserId = discordUserId;
      gameRooms.set(roomCode, room);
      emitControlState(roomCode, room);
    }
  });

  // Host lever pull on the Randomizer's Power-ups tab. Every connected,
  // teamed player with a skill equipped (and not yet granted it) rolls that
  // skill's grantChance. Winners are added to room.skillsGranted, which is
  // what unlocks the in-game button. The roll happens here; the host's client
  // gets the winners back through the socket ack and builds the slot-machine
  // result from them (the spin is then broadcast via `randomizerUpdate`).
  socket.on('hostPowerDraw', ({ roomCode: rawRoomCode } = {}, ack) => {
    const reply = (payload) => { if (typeof ack === 'function') ack(payload); };
    if (typeof rawRoomCode !== 'string') { reply({ error: 'Bad request.' }); return; }
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) { reply({ error: 'Bad request.' }); return; }
    if (!socket.isHost || socket.gameRoomCode !== roomCode) {
      socket.emit('errorMsg', 'Only the host can spin the Power-ups.');
      reply({ error: 'Only the host can spin the Power-ups.' });
      return;
    }

    const room = gameRooms.get(roomCode);
    if (!room) { reply({ error: 'Room not found.' }); return; }

    const data = room.board?.data;
    const rd = data?.rounds?.[data.currentRound] || data?.rounds?.[0];
    if (rd?.type === 'final') {
      socket.emit('errorMsg', 'Power-ups are disabled during Final Jeopardy.');
      reply({ error: 'Power-ups are disabled during Final Jeopardy.' });
      return;
    }

    room.skillsGranted = room.skillsGranted || {};
    console.log('[powerDraw] players:', (room.players || []).map(p => ({ id: p.discordUserId, team: p.teamId, connected: p.connected })));
    const results = [];
    const seen = new Set();
    for (const player of room.players || []) {
      const uid = player.discordUserId;
      if (!uid || !player.teamId || player.connected === false || seen.has(uid)) continue;
      seen.add(uid);

      const already = room.skillsGranted[uid] || [];
      for (const skill of getEquippedSkills(uid)) {
        if (already.includes(skill.id)) continue;
        const won = Math.random() < skill.grantChance;
        console.log('[powerDraw] roll', uid, skill.id, 'chance =', skill.grantChance, 'won =', won);
        results.push({
          discordUserId: uid,
          username: player.discordUsername || uid,
          teamId: player.teamId,
          skillId: skill.id,
          skillName: skill.name,
          won,
        });
      }
    }
    gameRooms.set(roomCode, room);

    // Nothing is granted yet: this roll is only a preview for the host. The
    // winners are held here until the host confirms with `hostPowerApply`.
    room.pendingDraw = results.filter((r) => r.won).map((r) => ({ discordUserId: r.discordUserId, skillId: r.skillId }));
    // Only the winners are needed by the Randomizer (per-skill, per-player).
    reply({
      winners: results
        .filter((r) => r.won)
        .map((r) => ({ discordUserId: r.discordUserId, skillId: r.skillId, skillName: r.skillName })),
    });
  });

  // Host clicks "Apply Power-ups" after the spin. Only now does anyone receive
  // anything: the previewed skill winners are unlocked, and every item shown in
  // the spin is stored for its player. Each player is sent only their own.
  socket.on('hostPowerApply', ({ roomCode: rawRoomCode, playerPowerups } = {}, ack) => {
    const reply = (payload) => { if (typeof ack === 'function') ack(payload); };
    if (typeof rawRoomCode !== 'string') { reply({ error: 'Bad request.' }); return; }
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) { reply({ error: 'Bad request.' }); return; }
    if (!socket.isHost || socket.gameRoomCode !== roomCode) {
      socket.emit('errorMsg', 'Only the host can apply the Power-ups.');
      reply({ error: 'Only the host can apply the Power-ups.' });
      return;
    }
    const room = gameRooms.get(roomCode);
    if (!room) { reply({ error: 'Room not found.' }); return; }

    const data = room.board?.data;
    const rd = data?.rounds?.[data.currentRound] || data?.rounds?.[0];
    if (rd?.type === 'final') { reply({ error: 'Power-ups are disabled during Final Jeopardy.' }); return; }

    room.skillsGranted = room.skillsGranted || {};
    room.powerupsGranted = room.powerupsGranted || {};

    for (const w of room.pendingDraw || []) {
      const have = room.skillsGranted[w.discordUserId] || [];
      if (!have.includes(w.skillId)) room.skillsGranted[w.discordUserId] = [...have, w.skillId];
    }
    room.pendingDraw = [];

    const known = new Set((room.players || []).map((p) => p.discordUserId).filter(Boolean));
    if (playerPowerups && typeof playerPowerups === 'object') {
      for (const [uid, labels] of Object.entries(playerPowerups)) {
        if (!known.has(uid) || !Array.isArray(labels)) continue;
        const clean = labels.filter((l) => typeof l === 'string' && l.length <= 40).slice(0, 3);
        room.powerupsGranted[uid] = [...(room.powerupsGranted[uid] || []), ...clean];
      }
    }

    gameRooms.set(roomCode, room);
    broadcastGrants(roomCode, room);
    reply({ ok: true });
  });

  // Player uses an equipped skill. Validates identity (the roster entry must
  // belong to THIS socket), Final Jeopardy lockout, ownership + equipped
  // state, once-per-game use, and no overlapping cutscenes.
  socket.on('useSkill', ({ roomCode: rawRoomCode, skillId, discordUserId }) => {
    if (typeof rawRoomCode !== 'string' || typeof skillId !== 'string' || !discordUserId) return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;
    if (skillId !== SKILL_DOMAIN_EXPANSION) {
      socket.emit('errorMsg', 'Unknown skill.');
      return;
    }

    const room = gameRooms.get(roomCode);
    if (!room) return;

    const player = (room.players || []).find(
      (p) => p.discordUserId === discordUserId && p.socketId === socket.id
    );
    if (!player || !player.teamId) {
      socket.emit('errorMsg', 'Not registered in this room.');
      return;
    }

    const data = room.board?.data;
    const rd = data?.rounds?.[data.currentRound] || data?.rounds?.[0];
    if (rd?.type === 'final') {
      socket.emit('errorMsg', 'Skills cannot be used during Final Jeopardy.');
      return;
    }
    if (room.activeClue) {
      socket.emit('errorMsg', 'Domain Expansion cannot be used while a clue is open.');
      return;
    }
    if (room.skillBusyUntil && Date.now() < room.skillBusyUntil) {
      socket.emit('errorMsg', 'Another skill is already playing.');
      return;
    }
    if (!hasEquippedSkill(discordUserId, skillId)) {
      socket.emit('errorMsg', 'You do not have that skill equipped.');
      return;
    }

    const granted = room.skillsGranted?.[discordUserId] || [];
    if (!granted.includes(skillId)) {
      socket.emit('errorMsg', 'You have not been granted that skill yet — wait for a Power-ups spin.');
      return;
    }

    room.skillsUsed = room.skillsUsed || {};
    const used = room.skillsUsed[discordUserId] || [];
    if (used.includes(skillId)) {
      socket.emit('errorMsg', 'You already used that skill this game.');
      return;
    }

    const deltas = (data?.teams || [])
      .filter((t) => t.id !== player.teamId && Number(t.score) > 0)
      .map((t) => ({
        teamId: t.id,
        teamName: t.name,
        delta: -Math.min(CLEAVE_MAX_LOSS, Math.round(Number(t.score) * CLEAVE_PERCENT)),
      }))
      .filter((d) => d.delta !== 0);

    room.skillsUsed[discordUserId] = [...used, skillId];
    room.skillBusyUntil = Date.now() + SKILL_ANIMATION_MS;
    gameRooms.set(roomCode, room);

    io.to(roomCode).emit('skillsUsedUpdate', room.skillsUsed);
    io.to(roomCode).emit('skillUsed', {
      skillId,
      effect: 'cleave',
      discordUserId,
      username: player.discordUsername || discordUserId,
      teamId: player.teamId,
      deltas,
    });
  });

  // Player activates one of their granted power-ups. Allowed during a clue and
  // on the board. Validates identity, Final Jeopardy lockout and that the
  // player actually holds the item, then consumes it and applies its effect.
  socket.on('usePowerup', ({ roomCode: rawRoomCode, label, discordUserId, targetTeamId } = {}, ack) => {
    const reply = (payload) => { if (typeof ack === 'function') ack(payload); };
    const fail = (msg) => { socket.emit('errorMsg', msg); reply({ error: msg }); };
    if (typeof rawRoomCode !== 'string' || typeof label !== 'string' || !discordUserId) { reply({ error: 'Bad request.' }); return; }
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) { reply({ error: 'Bad request.' }); return; }
    const kind = POWERUP_KINDS[label];
    if (!kind) return fail('Unknown power-up.');

    const room = gameRooms.get(roomCode);
    if (!room) { reply({ error: 'Room not found.' }); return; }

    const player = (room.players || []).find(
      (p) => p.discordUserId === discordUserId && p.socketId === socket.id
    );
    if (!player || !player.teamId) return fail('Not registered in this room.');
    if (currentRound(room)?.type === 'final') return fail('Power-ups cannot be used during Final Jeopardy.');

    const held = room.powerupsGranted?.[discordUserId] || [];
    const heldIdx = held.indexOf(label);
    if (heldIdx === -1) return fail('You do not have that power-up.');

    const teams = room.board?.data?.teams || [];
    const clue = findActiveClue(room);
    const inClue = !!room.activeClue;
    const teamId = player.teamId;
    let hint = null;

    // ── per-kind validation (nothing is consumed until every check passes) ──
    if (kind === 'double' || kind === 'shield') {
      if ((room.armedPowerups || []).some((a) => a.kind === kind && a.teamId === teamId)) {
        return fail(`Your team already has ${label} ready.`);
      }
    } else if (kind === 'steal') {
      if (room.controlDiscordUserId === discordUserId) return fail('You already have board control.');
    } else if (kind === 'freeze') {
      const target = teams.find((t) => t.id === targetTeamId);
      if (!target || target.id === teamId) return fail('Pick an opposing team to freeze.');
      if (room.frozenTeams?.[target.id]) return fail(`${target.name} is already frozen.`);
    } else if (kind === 'hint') {
      if (!inClue || !clue) return fail('Hint can only be used while a clue is open.');
      if (room.activeClue.revealed) return fail('The answer is already revealed.');
      hint = buildAnswerHint(clue.answer);
      if (!hint) return fail('This clue has no answer to hint at.');
    } else if (kind === 'rebuzz') {
      if (!inClue) return fail('Re-Buzz can only be used while a clue is open.');
      if (!room.buzzer?.live) return fail('The buzzer is not live right now.');
      if (room.frozenTeams?.[teamId]?.live) return fail('Your team is frozen.');
      const q = room.buzzer.queue || [];
      if (q[room.buzzer.activeIndex]?.id === discordUserId) return fail('You already have the floor.');
    }

    // ── consume ──
    const next = [...held];
    next.splice(heldIdx, 1);
    room.powerupsGranted = { ...(room.powerupsGranted || {}), [discordUserId]: next };

    const myTeam = teams.find((t) => t.id === teamId);
    const notice = {
      label, kind,
      discordUserId,
      username: player.discordUsername || discordUserId,
      teamId,
      teamName: myTeam?.name || 'Team',
      targetTeamId: null,
      targetTeamName: null,
    };

    // ── apply ──
    if (kind === 'double' || kind === 'shield') {
      room.armedPowerups = [
        ...(room.armedPowerups || []),
        { id: `pu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, kind, label, discordUserId, username: notice.username, teamId },
      ];
    } else if (kind === 'steal') {
      room.controlDiscordUserId = discordUserId;
      emitControlState(roomCode, room);
    } else if (kind === 'freeze') {
      const target = teams.find((t) => t.id === targetTeamId);
      notice.targetTeamId = target.id;
      notice.targetTeamName = target.name;
      room.frozenTeams = { ...(room.frozenTeams || {}), [target.id]: { live: inClue } };
      // A clue is already running: bump the frozen team's people who are still
      // waiting in the queue (whoever currently has the floor keeps it).
      if (inClue && room.buzzer?.queue?.length) {
        const b = room.buzzer;
        const queue = b.queue.filter((e, i) => i <= b.activeIndex || teamOfPlayer(room, e.id) !== target.id);
        if (queue.length !== b.queue.length) {
          room.buzzer = { ...b, queue };
          io.to(roomCode).emit('buzzerState', room.buzzer);
        }
      }
    } else if (kind === 'rebuzz') {
      const b = room.buzzer;
      const existing = (b.queue || []).find((e) => e.id === discordUserId);
      const entry = existing || {
        id: discordUserId,
        username: player.discordUsername || discordUserId,
        avatarUrl: player.discordAvatarUrl,
      };
      const rest = (b.queue || []).filter((e) => e.id !== discordUserId);
      // Insert at the current floor position; whoever held it moves down one.
      // (After removing the caster, indices before `at` are unaffected only if
      // the caster wasn't ahead of it — recompute `at` on the filtered list.)
      const oldIdx = (b.queue || []).findIndex((e) => e.id === discordUserId);
      let at = Math.max(0, b.activeIndex);
      if (oldIdx !== -1 && oldIdx < at) at -= 1;
      rest.splice(at, 0, entry);
      room.buzzer = { ...b, queue: rest, activeIndex: at };
      io.to(roomCode).emit('buzzerState', room.buzzer);
    }

    gameRooms.set(roomCode, room);
    broadcastGrants(roomCode, room);
    broadcastPowerupState(roomCode, room);
    io.to(roomCode).emit('powerupUsed', { ...notice, at: Date.now() });
    if (kind === 'hint') socket.emit('powerupHint', { label, hint, catId: room.activeClue.catId, value: room.activeClue.value });
    reply({ ok: true });
  });

  // Host reports that an armed effect (2x / Shield) was just applied to a
  // score, so it is spent. Host-only — players can't clear each other's.
  socket.on('hostConsumeArmed', ({ roomCode: rawRoomCode, id } = {}) => {
    if (typeof rawRoomCode !== 'string' || typeof id !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;
    if (!socket.isHost || socket.gameRoomCode !== roomCode) return;
    const room = gameRooms.get(roomCode);
    if (!room?.armedPowerups) return;
    room.armedPowerups = room.armedPowerups.filter((a) => a.id !== id);
    gameRooms.set(roomCode, room);
    broadcastPowerupState(roomCode, room);
  });

  // Host override — manual assign, used as the fallback when the current
  // control holder disconnects and doesn't come back within the grace
  // window (see the 'disconnect' handler below), whenever the host wants
  // to hand the board to someone else, or to open it up to everyone by
  // passing OPEN_CONTROL (falls straight through — this handler doesn't
  // care what the string is, it just stores it).
  socket.on('hostSetControl', ({ roomCode: rawRoomCode, discordUserId }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    const room = gameRooms.get(roomCode);
    if (!room) return;

    room.controlDiscordUserId = discordUserId || null;
    gameRooms.set(roomCode, room);
    emitControlState(roomCode, room);
  });

  // Live "for the show" state, same treatment as activeClue — which
  // category headers have been reveal-clicked by the host. Not part of
  // persisted board data (see useBoardGrid.js), so it gets its own tiny
  // relay rather than going through boardUpdate.
  socket.on('revealedCatsUpdate', ({ roomCode: rawRoomCode, revealedCats }) => {
    if (typeof rawRoomCode !== 'string' || !Array.isArray(revealedCats)) return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode) return;

    const room = gameRooms.get(roomCode) || {};
    room.revealedCats = revealedCats;
    gameRooms.set(roomCode, room);
    socket.to(roomCode).emit('revealedCatsUpdate', room.revealedCats);
  });

  // "DOUBLE JEOPARDY!"-style round-switch banner — same treatment as
  // revealedCats/activeClue: live "for the show" state, not part of
  // persisted board data (see useBoardGrid.js's roundBanner), so it gets
  // its own tiny relay rather than going through boardUpdate. Deliberately
  // NOT re-sent to late-joining sockets (unlike revealedCats/activeClue
  // above) since the banner is a ~1s transient pop-up — a player joining
  // mid-animation just misses it, same as missing any other in-progress
  // one-off effect; the round itself is already reflected in boardData.
  socket.on('roundBannerUpdate', ({ roomCode: rawRoomCode, roundBanner }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode) return;

    const room = gameRooms.get(roomCode) || {};
    room.roundBanner = roundBanner || null;
    gameRooms.set(roomCode, room);
    socket.to(roomCode).emit('roundBannerUpdate', room.roundBanner);
  });

  // Background music "now playing" state — same treatment as activeClue:
  // not part of persisted board data, live "for the show" only. Carries
  // enough for a late-joining player to compute the correct playback
  // position (positionSeconds + elapsed time since updatedAt), but
  // deliberately no volume — each client's volume is local-only, never
  // synced. See useBgmSync.js (host) and usePlayerSync.js (player).
  socket.on('bgmUpdate', ({ roomCode: rawRoomCode, bgm }) => {
    if (typeof rawRoomCode !== 'string' || !bgm) return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode) return;

    const room = gameRooms.get(roomCode) || {};
    room.bgm = bgm;
    gameRooms.set(roomCode, room);
    socket.to(roomCode).emit('bgmUpdate', room.bgm);
  });

  // Team randomizer — same treatment as activeClue/revealedCats: resent to
  // late-joining sockets (see the joinRoom/joinAsPlayer resends above),
  // unlike the transient roundBanner. "Host is on the randomizer screen
  // with this order locked in" should survive a player's refresh mid-spin,
  // not just be missed like a one-off animation would be.
  socket.on('randomizerUpdate', ({ roomCode: rawRoomCode, randomizer }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode) return;

    const room = gameRooms.get(roomCode) || {};
    room.randomizer = randomizer || null;
    gameRooms.set(roomCode, room);
    const playerSockets = (room.players || []).filter((p) => p.socketId);
    for (const p of playerSockets) {
      io.to(p.socketId).emit('randomizerUpdate', randomizerFor(room, { id: p.socketId, isHost: false }));
    }
    socket.to(roomCode).except(playerSockets.map((p) => p.socketId)).emit('randomizerUpdate', room.randomizer);
  });

  socket.on('boardUpdate', ({ roomCode: rawRoomCode, data, updatedAt }) => {
    if (typeof rawRoomCode !== 'string' || !data) return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode) return;
    if (!socket.isHost || socket.gameRoomCode !== roomCode) {
      socket.emit('errorMsg', 'Only the host can update the board.');
      return;
    }

    let payloadBytes;
    try {
      payloadBytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
    } catch {
      socket.emit('errorMsg', 'Invalid board data.');
      return;
    }
    if (payloadBytes > MAX_BOARD_PAYLOAD_BYTES || typeof data !== 'object' || Array.isArray(data)) {
      socket.emit('errorMsg', 'Board data is invalid or too large.');
      return;
    }

    const room = gameRooms.get(roomCode) || {};
    mergeLivePlayerMemberships(data, room.players);
    if (Object.prototype.hasOwnProperty.call(data, 'controlDiscordUserId')) {
      room.controlDiscordUserId = data.controlDiscordUserId || null;
    }
    room.board = { data, updatedAt: updatedAt || Date.now() };
    gameRooms.set(roomCode, room);

    // socket.to(...) ensures the host doesn't receive its own echo back
    socket.to(roomCode).emit('boardUpdate', room.board);
    emitControlState(roomCode, room);
  });

  socket.on('watchVoiceChannel', (rawChannelId) => {
    if (typeof rawChannelId !== 'string' || !rawChannelId) return;
    const channelId = rawChannelId.trim();
    if (!channelId) return;

    // Stop watching whatever channel this socket was previously watching.
    if (socket.watchedVoiceChannelId && socket.watchedVoiceChannelId !== channelId) {
      const prevWatchers = watchersByChannel.get(socket.watchedVoiceChannelId);
      prevWatchers?.delete(socket.id);
      if (prevWatchers && prevWatchers.size === 0) watchersByChannel.delete(socket.watchedVoiceChannelId);
    }

    socket.watchedVoiceChannelId = channelId;
    if (!watchersByChannel.has(channelId)) watchersByChannel.set(channelId, new Set());
    watchersByChannel.get(channelId).add(socket.id);

    socket.emit('voiceState', buildVoiceMemberList(channelId));
  });

  socket.on('joinAsPlayer', ({ roomCode: rawRoomCode, teamName, discordUser }) => {
    if (typeof rawRoomCode !== 'string' || typeof teamName !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    const trimmedName = teamName.trim();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH || !trimmedName || trimmedName.length > MAX_TEAM_NAME_LENGTH) return;
    if (invalidatedRoomCodes.has(roomCode)) {
      socket.emit('errorMsg', 'This room code has been replaced.');
      return;
    }

    socket.join(roomCode);
    socket.gameRoomCode = roomCode;

    const room = gameRooms.get(roomCode) || {};
    room.board = room.board || { data: { teams: [] }, updatedAt: Date.now() };
    room.board.data = room.board.data || { teams: [] };
    room.board.data.teams = room.board.data.teams || [];
    room.players = room.players || [];
    room.pendingRemovals = room.pendingRemovals || new Map();

    // If this Discord user already has a roster entry in this room, this
    // is almost certainly a reconnect (tab refresh, brief network drop)
    // rather than a fresh join. Reuse their existing entry: cancel any
    // pending grace-period removal, point it at the new socket, and keep
    // them on whatever team they were already assigned to. This is what
    // stops a reconnect from spawning a duplicate/blank team and wiping
    // their score — we deliberately skip the find-or-create-by-name logic
    // below entirely in this case.
    const existing = discordUser?.id
      ? room.players.find((p) => p.discordUserId === discordUser.id)
      : null;

    if (existing) {
      const pending = room.pendingRemovals.get(discordUser.id);
      if (pending) clearTimeout(pending);
      room.pendingRemovals.delete(discordUser.id);

      existing.socketId = socket.id;
      existing.connected = true;
      existing.discordUsername = discordUser.username || existing.discordUsername;
      existing.discordAvatarUrl = discordUser.avatarUrl || existing.discordAvatarUrl;

      gameRooms.set(roomCode, room);

      const team = room.board.data.teams.find((t) => t.id === existing.teamId);
      socket.emit('joinedTeam', { teamId: existing.teamId, teamName: team?.name || trimmedName });
      io.to(roomCode).emit('playersUpdate', room.players);

      // Reconnect path was previously missing this — the fresh-join branch
      // below sends boardUpdate, but a returning player (tab refresh, brief
      // drop) landed here instead and never got the board at all, since
      // usePlayerSync's boardData starts at null on every fresh mount and
      // nothing else would resend it until the host's next edit. Without
      // this, a mid-game refresh could leave a player staring at a blank
      // board indefinitely.
      if (room.board) socket.emit('boardUpdate', room.board);

      if (room.buzzer) socket.emit('buzzerState', room.buzzer);
      if (room.activeClue !== undefined) socket.emit('activeClueUpdate', room.activeClue);
      if (room.revealedCats) socket.emit('revealedCatsUpdate', room.revealedCats);
      if (room.bgm !== undefined) socket.emit('bgmUpdate', room.bgm);
      if (room?.randomizer) socket.emit('randomizerUpdate', randomizerFor(room, socket));
      socket.emit('controlChanged', { controlDiscordUserId: room.controlDiscordUserId ?? null });
      if (room.playerStats) socket.emit('statsUpdate', room.playerStats);
    socket.emit('skillsUsedUpdate', room?.skillsUsed || {});
    sendGrantsTo(socket, room);
      return;
    }

    // Find-or-create the team by name (case-insensitive), same convention
    // client-side code already uses ("t_" + random id, discordUserIds array).
    let team = room.board.data.teams.find(
      (t) => t.name && t.name.trim().toLowerCase() === trimmedName.toLowerCase()
    );
    if (!team) {
      team = { id: 't_' + Math.random().toString(36).slice(2, 9), name: trimmedName, score: 0, discordUserIds: [] };
      room.board.data.teams.push(team);
    }
    if (!Array.isArray(team.discordUserIds)) team.discordUserIds = [];
    if (discordUser?.id && !team.discordUserIds.includes(discordUser.id)) {
      team.discordUserIds.push(discordUser.id);
    }

    // Track this socket's player roster entry so we can clean up on disconnect
    // and so host-side views can eventually show "who's connected".
    room.players = room.players.filter((p) => p.socketId !== socket.id);
    room.players.push({
      socketId: socket.id,
      discordUserId: discordUser?.id || null,
      discordUsername: discordUser?.username || null,
      discordAvatarUrl: discordUser?.avatarUrl || null,
      teamId: team.id,
      role: 'player',
      connected: true,
    });

    room.board.updatedAt = Date.now();
    gameRooms.set(roomCode, room);

    // Confirm to the joining socket which team it landed on, then sync
    // everyone in the room (including this socket) on the new board state.
    socket.emit('joinedTeam', { teamId: team.id, teamName: team.name });
    io.to(roomCode).emit('boardUpdate', room.board);
    io.to(roomCode).emit('playersUpdate', room.players);

    if (room.buzzer) socket.emit('buzzerState', room.buzzer);
    if (room.activeClue !== undefined) socket.emit('activeClueUpdate', room.activeClue);
    if (room.revealedCats) socket.emit('revealedCatsUpdate', room.revealedCats);
    if (room.bgm !== undefined) socket.emit('bgmUpdate', room.bgm);
    if (room?.randomizer) socket.emit('randomizerUpdate', randomizerFor(room, socket));
    socket.emit('controlChanged', { controlDiscordUserId: room.controlDiscordUserId ?? null });
    if (room.playerStats) socket.emit('statsUpdate', room.playerStats);
    socket.emit('skillsUsedUpdate', room?.skillsUsed || {});
    sendGrantsTo(socket, room);
  });

  // Deliberate "Leave" click, as opposed to a disconnect (tab close,
  // network drop, backgrounding). This is intentional, so it skips the
  // grace period entirely and removes the player immediately — no
  // waiting to see if they come back, because they've told us they're not.
  socket.on('leaveGame', (rawRoomCode, ack) => {
    const roomCode = typeof rawRoomCode === 'string' ? rawRoomCode.trim().toUpperCase() : socket.gameRoomCode;
    if (!roomCode) { if (typeof ack === 'function') ack({ ok: false }); return; }
    const room = gameRooms.get(roomCode);
    if (!room?.players) { if (typeof ack === 'function') ack({ ok: false }); return; }

    const leaving = room.players.find((p) => p.socketId === socket.id);
    if (!leaving) { if (typeof ack === 'function') ack({ ok: false }); return; }

    // Cancel any pending grace-period timer for this player — otherwise it
    // would still fire later and try to clean up an already-cleaned-up entry.
    if (leaving.discordUserId && room.pendingRemovals) {
      const pending = room.pendingRemovals.get(leaving.discordUserId);
      if (pending) clearTimeout(pending);
      room.pendingRemovals.delete(leaving.discordUserId);
    }

    room.players = room.players.filter((p) => p.socketId !== socket.id);
    gameRooms.set(roomCode, room);
    io.to(roomCode).emit('playersUpdate', room.players);
    detachFromTeamIfAbandoned(roomCode, leaving);

    socket.leave(roomCode);
    socket.gameRoomCode = null;

    // Ack tells the client the server has actually processed the leave —
    // only then is it safe to disconnect without falling back to the
    // grace-period path. See usePlayerSync.js's leaveGame().
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('armBuzzer', (rawRoomCode) => updateBuzzer(rawRoomCode, (buzzer) => ({ ...buzzer, live: true, queue: [], activeIndex: -1 })));
  socket.on('resetBuzzer', (rawRoomCode) => updateBuzzer(rawRoomCode, () => ({ live: false, queue: [], activeIndex: -1 })));
  socket.on('nextBuzzer', (rawRoomCode) => updateBuzzer(rawRoomCode, (buzzer) => ({ ...buzzer, activeIndex: buzzer.activeIndex + 1 })));
  socket.on('prevBuzzer', (rawRoomCode) => updateBuzzer(rawRoomCode, (buzzer) => ({ ...buzzer, activeIndex: Math.max(-1, buzzer.activeIndex - 1) })));
  
  socket.on('buzz', ({ roomCode: rawRoomCode, player }) => {
    if (!player?.id) return;
    if (typeof rawRoomCode === 'string') {
      const r = gameRooms.get(rawRoomCode.trim().toUpperCase());
      const tid = r ? teamOfPlayer(r, player.id) : null;
      if (tid && r.frozenTeams?.[tid]?.live) {
        socket.emit('errorMsg', 'Your team is frozen for this clue.');
        return;
      }
    }
    updateBuzzer(rawRoomCode, (buzzer) => {
      if (!buzzer.live || buzzer.queue.some((entry) => entry.id === player.id)) return buzzer;
      const queue = [...buzzer.queue, player];
      return { ...buzzer, queue, activeIndex: buzzer.activeIndex === -1 ? 0 : buzzer.activeIndex };
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);

    if (socket.watchedVoiceChannelId) {
      const watchers = watchersByChannel.get(socket.watchedVoiceChannelId);
      watchers?.delete(socket.id);
      if (watchers && watchers.size === 0) watchersByChannel.delete(socket.watchedVoiceChannelId);
    }

    const roomCode = socket.gameRoomCode;
    if (!roomCode) return;
    const room = gameRooms.get(roomCode);
    if (!room?.players) return;

    const leaving = room.players.find((p) => p.socketId === socket.id);
    if (!leaving) return;

    // No stable Discord identity to match a future reconnect against —
    // nothing to hold onto, so treat this as an immediate real leave,
    // same as the original behavior.
    if (!leaving.discordUserId) {
      room.players = room.players.filter((p) => p.socketId !== socket.id);
      gameRooms.set(roomCode, room);
      io.to(roomCode).emit('playersUpdate', room.players);
      detachFromTeamIfAbandoned(roomCode, leaving);
      return;
    }

    // Mark them disconnected but keep their roster entry (and team
    // membership) intact for a grace period, rather than tearing it down
    // immediately — see DISCONNECT_GRACE_MS above for why.
    leaving.connected = false;
    gameRooms.set(roomCode, room);
    io.to(roomCode).emit('playersUpdate', room.players);

    // NOTE: controlDiscordUserId is deliberately left untouched here. It's
    // keyed by discordUserId, not socketId, so a disconnect doesn't
    // invalidate it — if they reconnect within the grace window they still
    // hold the board. If the host wants to hand control to someone else
    // while this player is gone, that's what hostSetControl is for; we
    // don't auto-reassign it, same reasoning as detachFromTeamIfAbandoned
    // not auto-picking a new team.

    room.pendingRemovals = room.pendingRemovals || new Map();
    const key = leaving.discordUserId;
    const existingTimeout = room.pendingRemovals.get(key);
    if (existingTimeout) clearTimeout(existingTimeout);

    const timeout = setTimeout(() => {
      const r = gameRooms.get(roomCode);
      if (!r?.players) return;

      const stillGone = r.players.find((p) => p.discordUserId === key && p.connected === false);
      if (!stillGone) return; // they reconnected within the grace window — nothing to do

      r.players = r.players.filter((p) => p.discordUserId !== key);
      gameRooms.set(roomCode, r);
      io.to(roomCode).emit('playersUpdate', r.players);
      detachFromTeamIfAbandoned(roomCode, stillGone);
      r.pendingRemovals?.delete(key);
    }, DISCONNECT_GRACE_MS);

    room.pendingRemovals.set(key, timeout);
  });
});

function updateBuzzer(rawRoomCode, update) {
  if (typeof rawRoomCode !== 'string') return;
  const roomCode = rawRoomCode.trim().toUpperCase();
  if (!roomCode) return;
  const room = gameRooms.get(roomCode) || {};
  room.buzzer = update(room.buzzer || { live: false, queue: [], activeIndex: -1 });
  gameRooms.set(roomCode, room);
  io.to(roomCode).emit('buzzerState', room.buzzer);
}

// 6. Start HTTP Server and Login to Discord
server.listen(PORT, () => {
  console.log(`Socket & Bot server running on http://localhost:${PORT}`);
});

if (DISCORD_TOKEN) {
  client.login(DISCORD_TOKEN);
} else {
  console.warn('Warning: DISCORD_TOKEN not found. Skipping Discord client login.');
}