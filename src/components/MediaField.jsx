import React, { useRef } from "react";

export default function MediaField({ label, type, accept, placeholder, value, onUrlChange, onFile, onClear, hint }) {
  const fileInputRef = useRef(null);
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
      <div className="file-row">
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          onChange={(e) => {
            const file = e.target.files[0];
            onFile(file);
          }}
        />
        <span className="file-status">{value.fileName}</span>
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
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
