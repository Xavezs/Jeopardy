// src/components/GameBoard.jsx
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { discordSdk, setupDiscordSdk } from '../discordSdk';

// Initialize socket connection pointing directly to the socket/bot server port
const socket = io('http://localhost:4001', {
  autoConnect: true,
  withCredentials: true,
});

export default function GameBoard() {
  const [channelId, setChannelId] = useState(null);
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('Connecting to Discord...');
  const [buzzerWinner, setBuzzerWinner] = useState(null);
  const [isLocked, setIsLocked] = useState(false);

  useEffect(() => {
    async function initDiscord() {
      try {
        await setupDiscordSdk();

        const channel = discordSdk.channelId;
        const auth = discordSdk.auth;
        
        if (!channel) {
          throw new Error("Not running inside Discord client frame");
        }

        setChannelId(channel);
        setUser(auth?.user || { username: "Player" });
        setStatus('Connected to room!');

        socket.emit('join_room', { 
          channelId: channel, 
          user: auth?.user 
        });
      } catch (err) {
        console.warn('Using local fallback environment for testing:', err.message);
        
        const mockChannel = 'mock_channel_123';
        const mockUser = { username: `Player_${Math.floor(Math.random() * 1000)}` };
        
        setChannelId(mockChannel);
        setUser(mockUser);
        setStatus('Connected (Local Fallback)');
        
        socket.emit('join_room', { 
          channelId: mockChannel, 
          user: mockUser 
        });
      }
    }

    initDiscord();

    socket.on('buzzer_winner', (data) => {
      setBuzzerWinner(data.winner);
      setIsLocked(true);
    });

    socket.on('buzzer_reset', () => {
      setBuzzerWinner(null);
      setIsLocked(false);
    });

    return () => {
      socket.off('buzzer_winner');
      socket.off('buzzer_reset');
    };
  }, []);

  const handleBuzz = () => {
    if (isLocked || !channelId) return;
    socket.emit('press_buzzer', { channelId, user });
  };

  return (
    <div style={{ 
      display: 'flex', 
      flexDirection: 'column', 
      alignItems: 'center', 
      justifyContent: 'center', 
      minHeight: '100vh', 
      background: '#1a1a1a', 
      color: '#fff',
      fontFamily: 'sans-serif',
      textAlign: 'center',
      padding: '20px'
    }}>
      <h1>Jeopardy! Buzzer</h1>
      <p style={{ color: '#888', marginBottom: '10px' }}>{status}</p>
      <p style={{ fontSize: '14px', color: '#aaa', marginBottom: '30px' }}>Channel ID: {channelId || 'Loading...'}</p>

      <div style={{ 
        margin: '20px 0', 
        padding: '15px 25px', 
        background: buzzerWinner ? '#331a1a' : '#1a331a', 
        border: `2px solid ${buzzerWinner ? '#e74c3c' : '#2ecc71'}`, 
        borderRadius: '10px',
        width: '100%',
        maxWidth: '350px'
      }}>
        {buzzerWinner ? (
          <h3 style={{ color: '#ff4d4d', margin: 0 }}>🚨 {buzzerWinner.username} buzzed in first!</h3>
        ) : (
          <h3 style={{ color: '#2ecc71', margin: 0 }}>🟢 BUZZER IS OPEN</h3>
        )}
      </div>

      <button
        onClick={handleBuzz}
        disabled={isLocked}
        style={{
          width: '200px',
          height: '200px',
          borderRadius: '50%',
          background: isLocked ? '#555' : 'radial-gradient(circle, #ff5e5e 0%, #c0392b 100%)',
          color: '#fff',
          fontSize: '26px',
          fontWeight: 'bold',
          border: '6px solid #962d22',
          cursor: isLocked ? 'not-allowed' : 'pointer',
          boxShadow: isLocked ? 'none' : '0 10px 25px rgba(231, 76, 60, 0.4)',
          margin: '20px 0',
          transition: 'transform 0.1s ease'
        }}
        onMouseDown={(e) => !isLocked && (e.currentTarget.style.transform = 'scale(0.95)')}
        onMouseUp={(e) => !isLocked && (e.currentTarget.style.transform = 'scale(1)')}
      >
        {isLocked ? 'LOCKED' : 'BUZZ!'}
      </button>

      {user && (
        <p style={{ marginTop: '20px', color: '#aaa' }}>Playing as: <strong>{user.username}</strong></p>
      )}
    </div>
  );
}