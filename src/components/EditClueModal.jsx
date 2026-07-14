import React, { useState } from "react";
import MediaField from "./MediaField";

export default function EditClueModal({
  editForm,
  setEditForm,
  mediaState,
  setMediaState,
  onMediaFile,
  onClearMedia,
  onSave,
  onClose,
  defaultTimerSeconds,
}) {
  const [closing, setClosing] = useState(false);

  const requestClose = (cb) => {
    setClosing(true);
    setTimeout(() => cb(), 160);
  };

  return (
    <div
      className={"modal-overlay" + (closing ? " closing" : "")}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose(onClose);
      }}
    >
      <div className="modal">
        <div className="modal-title">Edit Clue</div>
        <div className="form-row">
          <label>Question / Prompt (shown first)</label>
          <textarea
            placeholder="e.g. This 1994 Disney film features a lion cub named Simba"
            value={editForm.question}
            onChange={(e) => setEditForm((f) => ({ ...f, question: e.target.value }))}
          />
        </div>
        <div className="form-row">
          <label>Answer (revealed on click)</label>
          <textarea
            placeholder="e.g. What is The Lion King?"
            value={editForm.answer}
            onChange={(e) => setEditForm((f) => ({ ...f, answer: e.target.value }))}
          />
        </div>

        <div className="form-row">
          <label>Timer override</label>
          <div className="timer-override-control">
            <span className="timer-override-icon" aria-hidden="true">⏱</span>
            <input
              type="number"
              min="1"
              placeholder={`Board default (${defaultTimerSeconds}s)`}
              value={editForm.timerSeconds}
              onChange={(e) => setEditForm((f) => ({ ...f, timerSeconds: e.target.value }))}
            />
            <span className="timer-override-suffix">sec</span>
          </div>
          <div className="hint">Leave blank to use the board's default timer length.</div>
        </div>

        <MediaField
          label="Media — image, video, or audio: paste a URL, or upload a file"
          type=""
          accept="image/*,video/*,audio/*"
          placeholder="https://... image, video, audio file, or a YouTube link"
          value={mediaState.media}
          onUrlChange={(url) => setMediaState((prev) => ({ ...prev, media: { ...prev.media, mode: "url", url } }))}
          onFile={(file) => onMediaFile("media", file)}
          onClear={() => onClearMedia("media")}
          hint="The type (image / video / audio) is detected automatically."
        />

        <div className="hint" style={{ textAlign: "center", marginBottom: 8 }}>
          Uploaded files stay embedded in the board itself, nothing goes to a server.
        </div>
        <div className="modal-footer">
          <button className="btn gold" onClick={() => requestClose(onSave)}>
            Save Clue
          </button>
          <button className="btn" onClick={() => requestClose(onClose)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}