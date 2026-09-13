import React, { useRef, useState } from "react";

// Extension -> kind lookup for the "has media?" badge below. Deliberately
// small/local (rather than importing the shared detectMediaTypeFromUrl
// from mediaStore.js) so this component doesn't pick up a dependency on
// wherever that file happens to live — this only has to answer "image,
// video, audio, or unknown", nothing else needs it to be exact.
const MEDIA_EXT_KIND = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "avif"],
  video: ["mp4", "webm", "ogv", "mov", "m4v"],
  audio: ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "weba"],
};
function detectKindFromName(name) {
  if (!name) return "";
  const cleaned = name.split(/[?#]/)[0];
  const ext = (cleaned.split(".").pop() || "").toLowerCase();
  for (const [kind, exts] of Object.entries(MEDIA_EXT_KIND)) {
    if (exts.includes(ext)) return kind;
  }
  return "";
}
const KIND_BADGE = {
  image: { icon: "🖼", label: "Image attached" },
  video: { icon: "🎬", label: "Video attached" },
  audio: { icon: "🎵", label: "Audio attached" },
};

export default function MediaField({ label, type, accept, placeholder, value, onUrlChange, onFile, onClear, hint }) {
  const fileInputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFiles = (files) => {
    const file = files && files[0];
    if (file) onFile(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  // "Is there actually media here right now" — a file upload counts once
  // it has a fileName, a URL counts once it's non-blank. Drive share
  // links and other extension-less URLs still count as "attached", they
  // just fall back to the generic 📎 badge below since we can't sniff
  // image/video/audio from the link text alone (same limitation as
  // detectMediaTypeFromUrl in mediaStore.js).
  const hasMedia = value.mode === "file" ? !!value.fileName : !!(value.url && value.url.trim());
  const kind = hasMedia ? detectKindFromName(value.mode === "file" ? value.fileName : value.url) : "";
  const badge = hasMedia ? KIND_BADGE[kind] || { icon: "📎", label: "File attached" } : null;

  return (
    <div className="form-row">
      <div className="media-field-label-row">
        <label>{label}</label>
        <span className={`media-status-badge${hasMedia ? " has-media" : " no-media"}`}>
          {hasMedia ? (
            <>
              <span className="media-status-icon">{badge.icon}</span>
              {badge.label}
            </>
          ) : (
            "No file"
          )}
        </span>
      </div>

      {value.mode === "file" && value.fileName ? (
        <div className="dropzone-file-chip">
          <span className="dropzone-file-icon">📎</span>
          <span className="dropzone-file-name">{value.fileName}</span>
          <button
            type="button"
            className="file-clear"
            title="Remove"
            onClick={() => {
              if (fileInputRef.current) fileInputRef.current.value = "";
              onClear();
            }}
          >
            ✕
          </button>
        </div>
      ) : (
        <div
          className={`media-input-row${isDragging ? " dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          <input
            type="url"
            placeholder={placeholder}
            value={value.url}
            onChange={(e) => onUrlChange(e.target.value)}
          />
          <button
            type="button"
            className="media-upload-btn"
            title={`Upload ${type || "a file"}`}
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
          >
            📎
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={accept}
            className="media-file-input-hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
      )}

      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}