// DiscordOverlay.jsx
// Renders live Discord voice-channel members as a floating overlay.
// Receives its data as props now instead of opening its own socket —
// JeopardyBoard.jsx owns the one shared connection via useDiscordMembers()
// and passes the same members/connected down to both this overlay AND the
// team cards, so we're not running two sockets for the same data.

export default function DiscordOverlay({ members = [], connected = false, position = 'bottom-right' }) {
  const positionStyles = {
    'bottom-right': { bottom: 16, right: 16 },
    'bottom-left': { bottom: 16, left: 16 },
    'top-right': { top: 16, right: 16 },
    'top-left': { top: 16, left: 16 },
  };

  if (!connected && members.length === 0) return null; // fail quietly, don't disrupt the app

  return (
    <div
      style={{
        position: 'fixed',
        ...positionStyles[position],
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: 'rgba(20, 20, 24, 0.85)',
        borderRadius: 12,
        padding: 10,
        zIndex: 9999,
        pointerEvents: 'none', // overlay shouldn't block clicks on your board
      }}
    >
      {members.map((m) => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative', width: 32, height: 32 }}>
            <img
              src={m.avatarUrl}
              alt={m.username}
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                border: m.speaking ? '2px solid #23a55a' : '2px solid transparent',
                boxShadow: m.speaking ? '0 0 0 2px #23a55a, 0 0 8px 2px rgba(35, 165, 90, 0.6)' : 'none',
                opacity: m.deafened ? 0.4 : 1,
                transition: 'border-color 100ms ease, box-shadow 100ms ease',
              }}
            />
            {m.muted && (
              <div
                style={{
                  position: 'absolute',
                  bottom: -2,
                  right: -2,
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: '#ed4245',
                  border: '2px solid rgba(20,20,24,0.85)',
                }}
                title="Muted"
              />
            )}
          </div>
          <span style={{ color: 'white', fontSize: 13, fontFamily: 'sans-serif' }}>
            {m.username}
          </span>
        </div>
      ))}
    </div>
  );
}