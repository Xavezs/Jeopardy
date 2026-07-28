// components/InviteModal.jsx
//
// Owner-only: generates (or reuses) this board's room code and shows a
// copyable code + shareable link. Wire up next to JoinRoomModal:
//
//   <InviteModal open={inviteOpen} boardId={session.id} onClose={() => setInviteOpen(false)} />
//
// A "Invite friends" button (only shown when `session.isOwner`) opens it.

import { useState, useEffect } from "react";
import { SessionStore } from "../lib/storage";

export default function InviteModal({ open, boardId, onClose }) {
  const [roomCode, setRoomCode] = useState(null);
  const [copied, setCopied] = useState("");

  useEffect(() => {
    if (open && boardId) {
      SessionStore.inviteToBoard(boardId).then((r) => setRoomCode(r.roomCode));
    }
  }, [open, boardId]);

  if (!open) return null;

  const link = roomCode ? `${window.location.origin}/?join=${roomCode}` : "";

  function copy(text, label) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 1500);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2>Invite friends</h2>
        {!roomCode ? (
          <p>Generating code…</p>
        ) : (
          <>
            <p>Share this code — anyone with it can join and edit this board:</p>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <code style={{ fontSize: "1.5rem", letterSpacing: "0.2em" }}>{roomCode}</code>
              <button onClick={() => copy(roomCode, "code")}>{copied === "code" ? "Copied!" : "Copy code"}</button>
            </div>
            <p style={{ marginTop: "1rem" }}>Or send this link — it fills the code in automatically:</p>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input readOnly value={link} style={{ flex: 1 }} onFocus={(e) => e.target.select()} />
              <button onClick={() => copy(link, "link")}>{copied === "link" ? "Copied!" : "Copy link"}</button>
            </div>
          </>
        )}
        <div className="modal-actions" style={{ marginTop: "1rem" }}>
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
