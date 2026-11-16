import React, { useState } from "react";
import "../styles/avatar.css";

// Drop-in replacement for <img src={avatarUrl}> on player/team avatars.
// No image (guests, failed load) -> gray silhouette. platform === "web" adds a small globe badge.
export default function Avatar({ src, platform, className = "", alt = "", style, title }) {
  const [failedSrc, setFailedSrc] = useState(null);

  if (src && src !== failedSrc) {
    return <img src={src} alt={alt} className={className} style={style} title={title} onError={() => setFailedSrc(src)} />;
  }

  const isWeb = platform === "web";
  return (
    <span
      className={`${className} avatar-empty`}
      style={style}
      title={title || (isWeb ? "Playing from a web browser" : undefined)}
      role="img"
      aria-label={alt || (isWeb ? "Web player" : "Player")}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="12" cy="9" r="4.2" />
        <path d="M3.5 22a8.5 8.5 0 0 1 17 0Z" />
      </svg>
      {isWeb && (
        <span className="avatar-web-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18" />
            <path d="M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3Z" />
          </svg>
        </span>
      )}
    </span>
  );
}
