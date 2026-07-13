import React from "react";
import { formatDate } from "../lib/utils";

export default function SessionsModal({
  session,
  sessionIndex,
  onClose,
  onLoad,
  onDuplicate,
  onDelete,
  onCreateNew,
  onRenameCommit,
}) {
  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal">
        <div className="modal-title">Saved Sessions</div>
        <div className="hint" style={{ textAlign: "center", marginBottom: 14 }}>
          Each session is a full, separate board — its own categories, clues, media and scores. Switching sessions won't touch the others.
        </div>
        <div className="session-list">
          {sessionIndex.length === 0 ? (
            <div className="empty-note">No saved sessions yet.</div>
          ) : (
            sessionIndex.map((meta) => (
              <div key={meta.id} className={"session-row" + (session.id === meta.id ? " current" : "")}>
                <div className="session-info">
                  <input
                    className="session-name-input"
                    defaultValue={meta.name}
                    key={meta.id + "-name"}
                    onBlur={(e) => onRenameCommit(meta, e.target.value)}
                  />
                  <div className="session-meta">
                    {meta.categoryCount || 0} categories · {meta.teamCount || 0} teams · updated {formatDate(meta.updatedAt)}
                  </div>
                </div>
                <div className="session-actions">
                  <button className="load" disabled={session.id === meta.id} onClick={() => onLoad(meta.id)}>
                    {session.id === meta.id ? "Current" : "Load"}
                  </button>
                  <button onClick={() => onDuplicate(meta.id, meta.name + " (copy)")}>Duplicate</button>
                  <button className="delete" onClick={() => onDelete(meta.id, meta.name)}>
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="modal-footer">
          <button className="btn gold" onClick={onCreateNew}>
            ＋ New Session
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
