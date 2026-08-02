const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const { router: authRouter } = require('./auth');

// Environment Variables & Port Config
const PORT = process.env.PORT || 4001;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// How long a disconnected player's team membership is held before we treat
// it as a real leave. Socket.IO fires 'disconnect' on tab-blur, brief
// network drops, and page refreshes — all of which reconnect within a
// second or two. Without this grace window, a disconnect instantly wipes
// the team (if they were its last member), and the reconnect that follows
// a moment later can't find that team anymore and creates a fresh one at
// score 0 — the "team resurrection" bug.
const DISCONNECT_GRACE_MS = 12000;

// 1. Initialize Express App
const app = express();

// Trust proxy so secure cookies work properly through Cloudflare Tunnels
app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(cookieParser());

// Mount Auth & API routes
app.use('/api/auth', authRouter);
app.use('/api/boards', require('./boards'));
app.use('/api/media', require('./media'));

// Initialize Socket.io Server
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Shared in-memory state for the browser host and player views.
const gameRooms = new Map();

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

// 5. Unified Socket.io Real-time Game Coordination
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('joinRoom', (rawRoomCode) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode) return;

    socket.join(roomCode);
    socket.gameRoomCode = roomCode;

    const room = gameRooms.get(roomCode);
    if (room?.board) socket.emit('boardUpdate', room.board);
    if (room?.buzzer) socket.emit('buzzerState', room.buzzer);
    if (room?.activeClue !== undefined) socket.emit('activeClueUpdate', room.activeClue);
    if (room?.revealedCats) socket.emit('revealedCatsUpdate', room.revealedCats);
    if (room?.bgm !== undefined) socket.emit('bgmUpdate', room.bgm);
    if (room) socket.emit('controlChanged', { controlDiscordUserId: room.controlDiscordUserId ?? null });
  });

  socket.on('activeClueUpdate', ({ roomCode: rawRoomCode, activeClue }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode) return;

    const room = gameRooms.get(roomCode) || {};
    room.activeClue = activeClue || null;
    gameRooms.set(roomCode, room);
    socket.to(roomCode).emit('activeClueUpdate', room.activeClue);
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
    if (!roomCode) return;

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
    if (!roomCode) return;

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
    if (!roomCode) return;

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
    if (!roomCode) return;

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
    if (!roomCode) return;

    const room = gameRooms.get(roomCode);
    if (!room) return;

    if (correct && discordUserId) {
      room.controlDiscordUserId = discordUserId;
      gameRooms.set(roomCode, room);
      emitControlState(roomCode, room);
    }
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
    if (!roomCode) return;

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

  socket.on('boardUpdate', ({ roomCode: rawRoomCode, data, updatedAt }) => {
    if (typeof rawRoomCode !== 'string' || !data) return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode) return;

    const room = gameRooms.get(roomCode) || {};
    room.board = { data, updatedAt: updatedAt || Date.now() };
    gameRooms.set(roomCode, room);
    
    // socket.to(...) ensures the host doesn't receive its own echo back
    socket.to(roomCode).emit('boardUpdate', room.board);
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
    if (!roomCode || !trimmedName) return;

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

      if (room.buzzer) socket.emit('buzzerState', room.buzzer);
      if (room.activeClue !== undefined) socket.emit('activeClueUpdate', room.activeClue);
      if (room.revealedCats) socket.emit('revealedCatsUpdate', room.revealedCats);
      if (room.bgm !== undefined) socket.emit('bgmUpdate', room.bgm);
      socket.emit('controlChanged', { controlDiscordUserId: room.controlDiscordUserId ?? null });
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
    socket.emit('controlChanged', { controlDiscordUserId: room.controlDiscordUserId ?? null });
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