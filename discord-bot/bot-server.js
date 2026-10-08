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
const { createBoardEmitters } = require('./boardRedaction');

// Environment Variables & Port Config
const PORT = process.env.PORT || 4001;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5180';
const allowedOrigins = FRONTEND_URL.split(',').map((origin) => origin.trim()).filter(Boolean);
const isAllowedOrigin = (origin) => !origin || allowedOrigins.includes(origin);

const DISCONNECT_GRACE_MS = 5 * 60 * 1000;
const MAX_BOARD_PAYLOAD_BYTES = 1_000_000;
const MAX_ROOM_CODE_LENGTH = 8;
const MAX_TEAM_NAME_LENGTH = 24;

// 1. Initialize Express App
const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });

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

// YouTube IFrame API proxy
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
      
      // Rewrite any hardcoded widgetapi URL
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

  // Validate the URL to prevent SSRF
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

const gameRooms = new Map();
const invalidatedRoomCodes = new Set();

// How often the empty-room sweep below runs
const ROOM_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const roomLastSeen = new Map();
function sweepEmptyRooms() {
  const now = Date.now();
  for (const [roomCode, room] of gameRooms) {
    const socketsInRoom = io.sockets.adapter.rooms.get(roomCode);
    if (socketsInRoom && socketsInRoom.size > 0) { roomLastSeen.set(roomCode, now); continue; } // someone's still actually connected
    const hasPendingReconnect = room?.pendingRemovals && room.pendingRemovals.size > 0;
    if (hasPendingReconnect) continue;
    if (!roomLastSeen.has(roomCode)) roomLastSeen.set(roomCode, now);
    if (now - roomLastSeen.get(roomCode) < ROOM_TTL_MS) continue;
    gameRooms.delete(roomCode);
    roomLastSeen.delete(roomCode);
  }
}

setInterval(sweepEmptyRooms, ROOM_SWEEP_INTERVAL_MS).unref();

const roomPersistence = createRoomPersistence({ supabase, gameRooms });

// VOICE PRESENCE (roster + mute/deaf only
const watchersByChannel = new Map();

function buildVoiceMemberList(channelId) {
  const channel = client.channels.cache.get(channelId);
  if (!channel || !channel.isVoiceBased?.()) return [];
  return channel.members.map((member) => ({
    id: member.id,
    username: member.displayName || member.user.username,
    avatarUrl: member.displayAvatarURL({ extension: 'png', size: 64 }),
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

client.on('voiceStateUpdate', (oldState, newState) => {
  if (oldState.channelId && watchersByChannel.has(oldState.channelId)) {
    broadcastVoiceState(oldState.channelId);
  }
  if (newState.channelId && newState.channelId !== oldState.channelId && watchersByChannel.has(newState.channelId)) {
    broadcastVoiceState(newState.channelId);
  }
});

// TEAM CLEANUP
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
  broadcastBoard(roomCode, room);
}

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

const OPEN_CONTROL = '__OPEN__';

// BOARD CONTROL
function emitControlState(roomCode, room) {
  io.to(roomCode).emit('controlChanged', { controlDiscordUserId: room.controlDiscordUserId ?? null });
}

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

// SKILLS (type 'skill' in shop.js)
const SKILL_DOMAIN_EXPANSION = 'skill_domain_expansion';
const DEFAULT_GRANT_CHANCE = 0.05;
const CLEAVE_PERCENT = 0.20;
const CLEAVE_MAX_LOSS = 1000;   // ...capped at this many points
const SKILL_ANIMATION_MS = 30 * 1000;

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

// Per-player privacy for power-ups
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
const registerHandlers = require('./handlers');
const { boardFor, broadcastBoard } = createBoardEmitters({ io, playerOfSocket });
const sendRoomState = createSendRoomState({ randomizerFor, sendGrantsTo, boardFor });
const hostAuth = createHostAuth({
  db,
  jwt,
  secret: SESSION_SECRET,
  cookieName: COOKIE_NAME,
  allowUnverified: process.env.ALLOW_UNVERIFIED_HOST === '1',
  allowEditorHost: process.env.ALLOW_EDITOR_HOST === '1',
});

io.use((socket, next) => {
  socket.userId = hostAuth.userIdFor(socket, socket.handshake?.auth?.ticket);
  next();
});
if (process.env.ALLOW_UNVERIFIED_SOCKETS === '1') {
  console.warn('[auth] ALLOW_UNVERIFIED_SOCKETS=1: clients may claim any Discord id. Do not use in production.');
}

const hostLocks = new Map();
function roomCodeExists(code) {
  if (gameRooms.has(code)) return true;
  try {
    return !!db.prepare('SELECT 1 FROM boards WHERE UPPER(room_code) = ?').get(code);
  } catch {
    return false;
  }
}
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
  boardFor,
  broadcastBoard,
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
  hostLocks,
  roomCodeExists,
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

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
withTimeout(roomPersistence.hydrate(), 5000)
  .catch(() => {})
  .finally(() => {
    roomPersistence.start();
    server.listen(PORT, () => {
      console.log(`Socket & Bot server running on http://localhost:${PORT}`);
    });
  });

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