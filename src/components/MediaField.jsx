import React, { useRef, useState } from "react";

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

  const acceptLabel = (accept || "")
    .split(",")
    .map((a) => a.trim().replace(/^\./, "").replace(/^.*\//, ""))
    .filter(Boolean)
    .join(", ");

  return (
    <div className="form-row">
      <label>{label}</label>
      <input
        type="url"
        placeholder={placeholder}
        disabled={value.mode === "file"}
        value={value.mode === "file" ? "" : value.url}
        onChange={(e) => onUrlChange(e.target.value)}
      />

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
          className={`dropzone${isDragging ? " dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={accept}
            className="dropzone-input"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <div className="dropzone-text">
            Drop or upload {type ? `your ${type}` : "an image/video/audio file"} here
          </div>
        </div>
      )}

      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}