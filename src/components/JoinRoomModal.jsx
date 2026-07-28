// components/JoinRoomModal.jsx
//
// Lets a friend join someone else's board either by typing the room code
// or by opening a link like https://yourapp.com/?join=K7QX9M — the code
// is picked up from the URL automatically and this modal opens pre-filled.
//
// Wire-up (in App.jsx, alongside your other modals):
//
//   const [joinOpen, setJoinOpen] = useState(false);
//   const [joinPrefill, setJoinPrefill] = useState("");
//   useEffect(() => {
//     const code = new URLSearchParams(window.location.search).get("join");
//     if (code) { setJoinPrefill(code); setJoinOpen(true); }
//   }, []);
//
//   <JoinRoomModal
//     open={joinOpen}
//     initialCode={joinPrefill}
//     onClose={() => setJoinOpen(false)}
//     onJoined={(board) => { /* load `board` the same way switchToSession does */ }}
//   />
//
// A "Join a game" button anywhere in your Toolbar can just setJoinOpen(true).

import { useState, useEffect } from "react";
import { SessionStore } from "../lib/storage";

export default function JoinRoomModal({ open, initialCode = "", onClose, onJoined }) {
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setCode(initialCode);
      setError("");
    }
  }, [open, initialCode]);

  if (!open) return null;

  async function handleJoin(e) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    setLoading(true);
    setError("");
    try {
      const board = await SessionStore.joinBoard(trimmed);
      onJoined(board);
      onClose();
    } catch (err) {
      setError(err.message === "Request failed: 404" ? "No game found with that code." : "Couldn't join — try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2>Join a game</h2>
        <form onSubmit={handleJoin}>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ROOM CODE"
            maxLength={6}
            autoFocus
            style={{ textTransform: "uppercase", letterSpacing: "0.15em", fontSize: "1.2rem", textAlign: "center" }}
          />
          {error && <p style={{ color: "crimson" }}>{error}</p>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={loading || !code.trim()}>
              {loading ? "Joining…" : "Join"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
