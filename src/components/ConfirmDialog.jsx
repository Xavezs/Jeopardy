import React from "react";

export default function ConfirmDialog({ dialog, onResolve }) {
  if (!dialog) return null;
  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onResolve(false);
      }}
    >
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal-title">{dialog.title}</div>
        <div className="hint" style={{ textAlign: "center", fontSize: 14, color: "var(--text)", marginBottom: 14 }}>
          {dialog.message}
        </div>
        <div className="modal-footer">
          <button className="btn gold" onClick={() => onResolve(true)}>
            {dialog.okLabel || "OK"}
          </button>
          {dialog.showCancel !== false && (
            <button className="btn" onClick={() => onResolve(false)}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
