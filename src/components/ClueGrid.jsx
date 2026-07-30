import React from "react";
import { playHoverTick, playClickSfx } from "../lib/boardSfx";

/* =========================================================================
   CLUE GRID
   The category headers + clue-value cells for the currently active round.
   Pulled out of JeopardyBoard.jsx, which had grown to handle board
   rendering, session management, sound synthesis, and Discord integration
   all in one file.

   This component is intentionally "dumb": it owns no state of its own
   (drag state, reveal state, board-flip animation state all still live in
   JeopardyBoard.jsx, since they're shared with other parts of the board
   like the round-switch banner) and just renders from props + calls the
   handlers it's given.
   ========================================================================= */
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
  blankClue,
}) {
  return (
    <div id="boardWrap">
      <div id="board" style={boardGridStyle}>
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
                return (
                  <div
                    key={cellKey}
                    className={
                      "clue-cell" +
                      (clue.used ? " used" : "") +
                      (editMode ? " edit-mode-cell" : "") +
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
                      e.dataTransfer.setData("text/plain", cellKey); // Firefox requires data to be set for drag to start
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
                      } else if (!clue.used) {
                        playClickSfx();
                        openClueModal(cat, v);
                      }
                    }}
                    onMouseEnter={() => {
                      if (editMode || !clue.used) playHoverTick();
                    }}
                  >
                    <div className="clue-value">${v}</div>
                    {editMode &&
                      clue.question?.trim() &&
                      clue.answer?.trim() && (
                        <div className={`media-dot ${clue.mediaUrl ? "has-media" : ""}`}>●</div>
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
