import React, { useState, useEffect } from "react";

export default function ConfirmDialog({ dialog, onResolve }) {
  const [closing, setClosing] = useState(false);

  // This component stays mounted permanently (it just returns null when idle),
  // so `closing` must be reset each time a *new* dialog request comes in —
  // otherwise it carries over "true" from the last close and the next dialog
  // plays its closing animation immediately instead of opening.
  useEffect(() => {
    if (dialog) setClosing(false);
  }, [dialog]);

  if (!dialog) return null;

  const requestResolve = (result) => {
    setClosing(true);
    setTimeout(() => onResolve(result), 160);
  };

  return (
    <div
      className={"modal-overlay" + (closing ? " closing" : "")}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestResolve(false);
      }}
    >
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal-title">{dialog.title}</div>
        <div className="hint" style={{ textAlign: "center", fontSize: 14, color: "var(--text)", marginBottom: 14 }}>
          {dialog.message}
        </div>
        <div className="modal-footer">
          <button className="btn gold" onClick={() => requestResolve(true)}>
            {dialog.okLabel || "OK"}
          </button>
          {dialog.showCancel !== false && (
            <button className="btn" onClick={() => requestResolve(false)}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}