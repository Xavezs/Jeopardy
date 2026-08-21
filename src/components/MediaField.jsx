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

  return (
    <div className="form-row">
      <label>{label}</label>

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