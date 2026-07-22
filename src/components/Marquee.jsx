import React from "react";
import MarqueeBulbs from "../lib/MarqueeBulbs";
import { formatDate } from "../lib/utils";

export default function Marquee({ editMode, title, sessionId, sessionName, sessionUpdatedAt, onTitleCommit }) {
  return (
    <>
      <div className={"marquee" + (editMode ? " editing" : "")}>
        {editMode ? null : <MarqueeBulbs />}
        <input
          className="marquee-title"
          maxLength={40}
          disabled={!editMode}
          defaultValue={title}
          key={"title-" + sessionId}
          onBlur={(e) => onTitleCommit(e.target.value || "GAME NIGHT")}
        />
      </div>
      <div className="session-bar">
        Session: <b>{sessionName}</b> · last saved {formatDate(sessionUpdatedAt)}
      </div>
    </>
  );
}
