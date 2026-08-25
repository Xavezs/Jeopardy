import React, { useState, useEffect } from "react";
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
  categoryName, 
  clueValue,    
}) {
  const [closing, setClosing] = useState(false);
  const mouseDownOnOverlay = React.useRef(false);
  const saveTimeout = React.useRef(null);
  const isFirstRender = React.useRef(true);

  const requestClose = (cb) => {
    // Flush any pending autosave immediately so a fast close (Esc,
    // backdrop click, etc.) can't race the debounce and drop an edit.
    if (saveTimeout.current) {
      clearTimeout(saveTimeout.current);
      saveTimeout.current = null;
      onSave();
    }
    setClosing(true);
    setTimeout(() => cb(), 160);
  };

  // Autosave: debounce so we're not firing onSave on every keystroke, but
  // edits are persisted without needing to click "Save Clue".
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => {
      onSave();
      saveTimeout.current = null;
    }, 600);
    return () => {
      if (saveTimeout.current) clearTimeout(saveTimeout.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editForm, mediaState]);

  // Esc closes the same way Cancel/backdrop-click does — no save.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") requestClose(onClose);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  return (
    <div
      className={"modal-overlay" + (closing ? " closing" : "")}
      onMouseDown={(e) => {
        mouseDownOnOverlay.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (mouseDownOnOverlay.current && e.target === e.currentTarget) {
          requestClose(onClose);
        }
        mouseDownOnOverlay.current = false;
      }}
    >
      <div className="modal edit-clue-modal">
        <div className="modal-title">
          Edit Clue {categoryName && clueValue ? `${categoryName} ${clueValue}` : ""}
        </div>

        <div className="edit-clue-body">
          {/* Left column: Question Text + Question Media */}
          <div className="edit-clue-col">
            <div className="form-row">
              <label>Question / Prompt (shown first)</label>
              <textarea
                placeholder="e.g. This 1994 Disney film features a lion cub named Simba"
                value={editForm.question}
                onChange={(e) => setEditForm((f) => ({ ...f, question: e.target.value }))}
              />
            </div>

            <MediaField
              label="Question media (optional)"
              type=""
              accept="image/*,video/*,audio/*"
              placeholder="https://... or upload a file"
              value={mediaState.media}
              onUrlChange={(url) => setMediaState((prev) => ({ ...prev, media: { ...prev.media, mode: "url", url } }))}
              onFile={(file) => onMediaFile("media", file)}
              onClear={() => onClearMedia("media")}
            />
          </div>

          {/* Right column: Answer Text + Answer Media */}
          <div className="edit-clue-col">
            <div className="form-row">
              <label>Answer (revealed on click)</label>
              <textarea
                placeholder="e.g. What is The Lion King?"
                value={editForm.answer}
                onChange={(e) => setEditForm((f) => ({ ...f, answer: e.target.value }))}
              />
            </div>

            <MediaField
              label="Answer media (optional)"
              type=""
              accept="image/*,video/*,audio/*"
              placeholder="https://... or upload a file"
              value={mediaState.answerMedia}
              onUrlChange={(url) => setMediaState((prev) => ({ ...prev, answerMedia: { ...prev.answerMedia, mode: "url", url } }))}
              onFile={(file) => onMediaFile("answerMedia", file)}
              onClear={() => onClearMedia("answerMedia")}
            />
          </div>
        </div>

        {/* Timer override centered at the bottom */}
        <div className="form-row edit-clue-timer-row" style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <label>Timer override</label>
          <div className="timer-override-control" style={{ width: '100%', maxWidth: '260px' }}>
            <span className="timer-override-icon" aria-hidden="true">⏱</span>
            <input
              type="number"
              min="1"
              placeholder={`Board default (${defaultTimerSeconds}s)`}
              value={editForm.timerSeconds}
              onChange={(e) => setEditForm((f) => ({ ...f, timerSeconds: e.target.value }))}
              onWheel={(e) => e.target.blur()}
            />
            <span className="timer-override-suffix">sec</span>
          </div>
        </div>

        <div className="hint edit-clue-footnote">
          Image / video / audio auto-detected · files stay embedded in the board.
        </div>
        <div className="modal-footer">
          <button className="btn gold" onClick={() => requestClose(onClose)}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}