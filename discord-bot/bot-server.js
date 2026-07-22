// bot-server.js
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const { Server } = require('socket.io');
const http = require('http');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const VOICE_CHANNEL_ID = process.env.DISCORD_VOICE_CHANNEL_ID;
const PORT = process.env.PORT || 4001;

if (!BOT_TOKEN || !GUILD_ID || !VOICE_CHANNEL_ID) {
  console.error('Missing DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, or DISCORD_VOICE_CHANNEL_ID in .env');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error('Missing DISCORD_CLIENT_ID in .env — needed to register the /buzz slash command.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

const httpServer = http.createServer();
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

// --- live speaking state, keyed by user id ---
// (separate from the per-broadcast member list so it survives across rebuilds)
const speakingUsers = new Set();
let voiceConnection = null;

/* =========================================================================
   BUZZER STATE
   `buzzerLive` — true only in the window between the host arming the
   buzzer (question revealed) and someone winning it. While true, the
   FIRST /buzz interaction wins; every /buzz after that is told they're
   too late until the host arms it again.
   `buzzerWinner` — whoever won the current window, or null if nobody has
   buzzed yet / it's just been reset. Cleared every time the buzzer is
   (re-)armed or reset.
   ========================================================================= */
let buzzerLive = false;
let buzzerWinner = null; // { id, username, avatarUrl, timestamp }

function broadcastBuzzerState() {
  io.emit('buzzerState', { live: buzzerLive, winner: buzzerWinner });
}

async function registerCommands() {
  const commands = [{ name: 'buzz', description: 'Buzz in!' }];
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Slash command /buzz registered.');
  } catch (err) {
    console.error('Failed to register /buzz slash command:', err);
  }
}

function buildMemberList(guild) {
  const channel = guild.channels.cache.get(VOICE_CHANNEL_ID);
  if (!channel) return [];

  return channel.members
    .filter((member) => member.id !== client.user.id) // exclude the bot itself
    .map((member) => ({
      id: member.id,
      username: member.displayName,
      avatarUrl: member.displayAvatarURL({ size: 128 }),
      muted: member.voice.mute || member.voice.selfMute,
      deafened: member.voice.deaf || member.voice.selfDeaf,
      speaking: speakingUsers.has(member.id),
    }));
}

function broadcastState() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  io.emit('voiceState', buildMemberList(guild));
}

// --- join the watched voice channel as a silent listener ---
async function connectToVoice(guild) {
  const channel = guild.channels.cache.get(VOICE_CHANNEL_ID);
  if (!channel) {
    console.error(`Voice channel ${VOICE_CHANNEL_ID} not found in guild.`);
    return;
  }

  voiceConnection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfMute: true,   // bot never talks
    selfDeaf: false,  // must be false, or it won't receive audio packets at all
  });

  try {
    await entersState(voiceConnection, VoiceConnectionStatus.Ready, 10_000);
    console.log('Voice connection ready, listening for speaking events.');
  } catch (err) {
    console.error('Voice connection failed to become ready:', err);
    return;
  }
  const receiver = voiceConnection.receiver; 
  const speakingTimeouts = new Map();

  receiver.speaking.on('start', (userId) => {
    clearTimeout(speakingTimeouts.get(userId));
    speakingUsers.add(userId);
    broadcastState();
  });

  receiver.speaking.on('end', (userId) => {
    const t = setTimeout(() => {
      speakingUsers.delete(userId);
      speakingTimeouts.delete(userId);
      broadcastState();
    }, 250);
    speakingTimeouts.set(userId, t);
  });
  voiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
    console.log('Voice connection disconnected, attempting reconnect...');
    try {
      await Promise.race([
        entersState(voiceConnection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(voiceConnection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // it's reconnecting, do nothing
    } catch {
      voiceConnection.destroy();
      speakingUsers.clear();
    }
  });
}

client.once('ready', async () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  await registerCommands();
  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) {
    await connectToVoice(guild);
    broadcastState();
  }
});

client.on('voiceStateUpdate', () => {
  broadcastState();
});

// --- /buzz slash command handler ---
// First interaction while buzzerLive wins the round and locks everyone
// else out (ephemeral replies so only the presser sees the result —
// nothing leaks onto the board through Discord itself).
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'buzz') return;

  if (!buzzerLive) {
    const msg = buzzerWinner
      ? `🔒 ${buzzerWinner.username} already buzzed in — wait for the host to reset.`
      : "⏳ The buzzer isn't open yet — wait for the host to reveal the clue.";
    await interaction.reply({ content: msg, ephemeral: true });
    return;
  }

  buzzerLive = false;
  buzzerWinner = {
    id: interaction.user.id,
    username: interaction.member?.displayName || interaction.user.username,
    avatarUrl: interaction.user.displayAvatarURL({ size: 128 }),
    timestamp: Date.now(),
  };
  broadcastBuzzerState();
  await interaction.reply({ content: '🔔 You buzzed in first!', ephemeral: true });
});

io.on('connection', (socket) => {
  console.log('Frontend connected:', socket.id);
  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) socket.emit('voiceState', buildMemberList(guild));
  socket.emit('buzzerState', { live: buzzerLive, winner: buzzerWinner });

  // Host-side controls, emitted from the board (ClueModal auto-arms on
  // reveal; Toolbar exposes a manual reset in case things get out of sync).
  socket.on('armBuzzer', () => {
    buzzerLive = true;
    buzzerWinner = null;
    broadcastBuzzerState();
  });

  socket.on('resetBuzzer', () => {
    buzzerLive = false;
    buzzerWinner = null;
    broadcastBuzzerState();
  });
});

httpServer.listen(PORT, () => {
  console.log(`Voice overlay server listening on http://localhost:${PORT}`);
});

client.login(BOT_TOKEN);