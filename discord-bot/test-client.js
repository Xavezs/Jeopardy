// test-client.js
const { io } = require('socket.io-client');

const socket = io('http://localhost:4001');

socket.on('connect', () => {
  console.log('✅ Connected to bot-server.js');
});

socket.on('voiceState', (members) => {
  console.log('\n--- Voice channel update ---');
  if (members.length === 0) {
    console.log('(no one in the channel, or bot cannot see it)');
  } else {
    members.forEach((m) => {
      console.log(`${m.username} | muted: ${m.muted} | deafened: ${m.deafened}`);
    });
  }
});

socket.on('connect_error', (err) => {
  console.log('❌ Connection error:', err.message);
});