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

        <MediaField
          label="Image — paste a URL, or upload a file"
          type="image"
          accept="image/*"
          placeholder="https://... .jpg / .png / .gif"
          value={mediaState.image}
          onUrlChange={(url) => setMediaState((prev) => ({ ...prev, image: { ...prev.image, mode: "url", url } }))}
          onFile={(file) => onMediaFile("image", file)}
          onClear={() => onClearMedia("image")}
        />
        <MediaField
          label="Video — paste a URL/YouTube link, or upload a file"
          type="video"
          accept="video/*"
          placeholder="https://... video file, or a YouTube link"
          value={mediaState.video}
          onUrlChange={(url) => setMediaState((prev) => ({ ...prev, video: { ...prev.video, mode: "url", url } }))}
          onFile={(file) => onMediaFile("video", file)}
          onClear={() => onClearMedia("video")}
          hint="Direct video file link, YouTube URL, or an uploaded file — any of the three works."
        />
        <MediaField
          label="Audio — paste a URL, or upload a file"
          type="audio"
          accept="audio/*"
          placeholder="https://... .mp3 / .wav"
          value={mediaState.audio}
          onUrlChange={(url) => setMediaState((prev) => ({ ...prev, audio: { ...prev.audio, mode: "url", url } }))}
          onFile={(file) => onMediaFile("audio", file)}
          onClear={() => onClearMedia("audio")}
        />

        <div className="hint" style={{ textAlign: "center", marginBottom: 8 }}>
          You can fill in any combination — e.g. an image AND audio on the same clue. Uploaded files stay embedded in the board itself, nothing goes to a server.
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