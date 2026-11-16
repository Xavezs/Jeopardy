import React from "react";
import { playHoverTick, playClickSfx } from "../lib/boardSfx";
import BoardSettingsPopover from "./BoardSettingsPopover";

// Small icon for the hover-preview media badge
function mediaBadgeIcon(type) {
  return { image: "🖼", video: "🎬", audio: "🎵" }[type] || "📎";
}

// CLUE GRID
export default function ClueGrid({
  rd,
  nCats,
  nRows,
  boardGridStyle,
  editMode,
  boardFlip,
  flipDelay,
  revealedCats,
  revealCategory,
  renameCategory,
  removeCategory,
  addCategory,
  changeRowValue,
  removeRow,
  addRow,
  dragSource,
  setDragSource,
  dragOverKey,
  setDragOverKey,
  swapClueCells,
  openEditModal,
  openClueModal,
  toggleDailyDouble,
  blankClue,
  // Board settings
  timerEnabled,
  timerDuration,
  sessionId,
  onToggleTimerEnabled,
  onSetTimerDuration,
  ddBuzzerEnabled,
  onToggleDdBuzzerEnabled,
  ddMinWagerZero,
  onToggleDdMinWagerZero,
  ddWagerBasisPlayerScore,
  onToggleDdWagerBasisPlayerScore,
  onRandomizeDailyDoubles,
}) {
  return (
    <div id="boardWrap">
      <div id="board" style={boardGridStyle}>
        {/* Gear settings cell */}
        {editMode && (
          <div
            className="board-settings-gear-cell"
            style={{ gridRow: 1, gridColumn: 1 }}
          >
            <BoardSettingsPopover
              timerEnabled={timerEnabled}
              timerDuration={timerDuration}
              sessionId={sessionId}
              onToggleTimerEnabled={onToggleTimerEnabled}
              onSetTimerDuration={onSetTimerDuration}
              ddBuzzerEnabled={ddBuzzerEnabled}
              onToggleDdBuzzerEnabled={onToggleDdBuzzerEnabled}
              ddMinWagerZero={ddMinWagerZero}
              onToggleDdMinWagerZero={onToggleDdMinWagerZero}
              ddWagerBasisPlayerScore={ddWagerBasisPlayerScore}
              onToggleDdWagerBasisPlayerScore={onToggleDdWagerBasisPlayerScore}
              onRandomizeDailyDoubles={onRandomizeDailyDoubles}
            />
          </div>
        )}

        {rd.categories.map((cat, catIndex) => {
          const isRevealed = editMode || revealedCats.has(cat.id);
          return (
            <div
              key={cat.id}
              className={
                "cat-cell" +
                (boardFlip === "out" ? " flip-out" : "") +
                (boardFlip === "in-start" ? " flip-in-start" : "") +
                (!isRevealed ? " cat-locked" : "")
              }
              style={{
                gridRow: "1",
                gridColumn: editMode ? catIndex + 2 : catIndex + 1,
                transitionDelay: flipDelay(catIndex),
              }}
            >
              {editMode ? (
                <>
                  <input
                    className="cat-name-input"
                    maxLength={30}
                    defaultValue={cat.name}
                    key={cat.id + "-name"}
                    onBlur={(e) => renameCategory(cat, e.target.value)}
                  />
                  <button className="cat-remove" title="Remove this category" onClick={() => removeCategory(cat)}>
                    ✕
                  </button>
                </>
              ) : isRevealed ? (
                <div className="cat-name cat-name-reveal">{cat.name}</div>
              ) : (
                <button className="cat-reveal-btn" title="Click to reveal this category" onClick={() => revealCategory(cat)}>
                  <span className="cat-reveal-mark">?</span>
                </button>
              )}
            </div>
          );
        })}

        {editMode && (
          <div className="grid-add-column-cell" style={{ gridColumn: nCats + 2, gridRow: `1 / span ${nRows + 1}` }}>
            <button title="Add Category Column" onClick={addCategory}>
              +
            </button>
          </div>
        )}

        {rd.values.map((v, rowIndex) => {
          const gridRowPosition = rowIndex + 2;
          return (
            <React.Fragment key={v}>
              {editMode && (
                <div className="row-control-cell" style={{ gridRow: gridRowPosition, gridColumn: 1 }}>
                  <input
                    className="row-value-input"
                    type="number"
                    min="1"
                    defaultValue={v}
                    key={v + "-value"}
                    title="Point value for this row"
                    onBlur={(e) => changeRowValue(v, e.target.value)}
                    onWheel={(e) => e.target.blur()}
                  />
                  <button className="row-delete-btn" title="Delete this row value pattern" onClick={() => removeRow(v)}>
                    <span className="icon">✕</span>
                  </button>
                </div>
              )}

              {rd.categories.map((cat, catIndex) => {
                const clue = cat.clues[v] || blankClue();
                const cellKey = cat.id + "-" + v;
                const hasPreview = editMode;
                const questionText = clue.question?.trim() || "No question yet";
                const answerText = clue.answer?.trim() || "No answer yet";
                return (
                  <div
                    key={cellKey}
                    className={
                      "clue-cell" +
                      (clue.used ? " used" : "") +
                      (editMode ? " edit-mode-cell" : "") +
                      (hasPreview ? " has-clue-preview" : "") +
                      (boardFlip === "out" ? " flip-out" : "") +
                      (boardFlip === "in-start" ? " flip-in-start" : "") +
                      (editMode && dragSource && dragSource.catId === cat.id && dragSource.value === v ? " drag-source" : "") +
                      (editMode && dragOverKey === cellKey && !(dragSource && dragSource.catId === cat.id && dragSource.value === v)
                        ? " drag-over"
                        : "")
                    }
                    style={{
                      gridRow: gridRowPosition,
                      gridColumn: editMode ? catIndex + 2 : catIndex + 1,
                      transitionDelay: flipDelay(catIndex),
                    }}
                    draggable={editMode}
                    onDragStart={(e) => {
                      if (!editMode) return;
                      setDragSource({ catId: cat.id, value: v });
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", cellKey);
                    }}
                    onDragOver={(e) => {
                      if (!editMode || !dragSource) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dragOverKey !== cellKey) setDragOverKey(cellKey);
                    }}
                    onDragLeave={() => {
                      setDragOverKey((k) => (k === cellKey ? null : k));
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (!editMode || !dragSource) return;
                      swapClueCells(dragSource, { catId: cat.id, value: v });
                      setDragSource(null);
                      setDragOverKey(null);
                    }}
                    onDragEnd={() => {
                      setDragSource(null);
                      setDragOverKey(null);
                    }}
                    onClick={() => {
                      if (editMode) {
                        playClickSfx();
                        openEditModal(cat, v);
                      } else {
                        playClickSfx();
                        openClueModal(cat, v);
                      }
                    }}
                    onMouseEnter={() => {
                      if (editMode || !clue.used) playHoverTick();
                    }}
                  >
                    {hasPreview ? (
                      <div className="cell-flip-viewport">
                        <div className="cell-flip-inner">
                          <div className="cell-flip-face cell-flip-front">
                            <div className="clue-value">${v}</div>
                            <div className="cell-preview-text">{questionText}</div>
                            {clue.mediaUrl && (
                              <span
                                className="clue-media-badge"
                                title={`${clue.mediaType || "file"} attached to the question`}
                              >
                                {mediaBadgeIcon(clue.mediaType)}
                              </span>
                            )}
                            <button
                              type="button"
                              className={"dd-toggle" + (clue.isDailyDouble ? " is-dd" : "")}
                              title={clue.isDailyDouble ? "Unmark as Daily Double" : "Mark as Daily Double"}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleDailyDouble(cat, v);
                              }}
                            >
                              DD
                            </button>
                          </div>
                          <div className="cell-flip-face cell-flip-back">
                            <div className="cell-preview-label">Answer</div>
                            <div className="cell-preview-text">{answerText}</div>
                            {clue.answerMediaUrl && (
                              <span
                                className="clue-media-badge"
                                title={`${clue.answerMediaType || "file"} attached to the answer`}
                              >
                                {mediaBadgeIcon(clue.answerMediaType)}
                              </span>
                            )}
                            <button
                              type="button"
                              className={"dd-toggle" + (clue.isDailyDouble ? " is-dd" : "")}
                              title={clue.isDailyDouble ? "Unmark as Daily Double" : "Mark as Daily Double"}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleDailyDouble(cat, v);
                              }}
                            >
                              DD
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="clue-value">${v}</div>
                        {editMode && (
                          <button
                            type="button"
                            className={"dd-toggle" + (clue.isDailyDouble ? " is-dd" : "")}
                            title={clue.isDailyDouble ? "Unmark as Daily Double" : "Mark as Daily Double"}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleDailyDouble(cat, v);
                            }}
                          >
                            DD
                          </button>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </React.Fragment>
          );
        })}

        {editMode && (
          <div className="grid-add-row-cell" style={{ gridColumn: `1 / span ${nCats + 1}`, gridRow: nRows + 2 }}>
            <button title="Add Value Row" onClick={addRow}>
              +
            </button>
          </div>
        )}
      </div>
    </div>
  );
}