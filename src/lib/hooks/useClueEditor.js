import { useState, useRef } from "react";
import { MediaStore, isMediaRef, detectMediaTypeFromFile, detectMediaTypeFromUrl } from "../storage";
import { isDataUrl, humanSize } from "../utils";

/* =========================================================================
   useClueEditor
   Owns the "play a clue" modal (activeClue/revealed/duckMusic) and the
   "edit a clue" modal (editingTarget/editForm/mediaState) plus the media
   upload flow for both question and answer media.

   This hook does NOT own the grid's clue data long-term — it only holds a
   DRAFT (editForm/mediaState) while a clue is being edited, and commits
   that draft back into the session's clue object via `board.currentRoundOf`
   on save. useBoardGrid remains the single source of truth for clue data.
   ========================================================================= */
export function useClueEditor({ sessionRef, touch, persist, currentRoundOf, appConfirm, appAlert }) {
  /* ---------------- CLUE PLAY MODAL ---------------- */
  const [activeClue, setActiveClue] = useState(null); // {catId, value}
  const [revealed, setRevealed] = useState(false);
  // True while the clue modal's own audio/video is playing — passed down to
  // BackgroundMusicPlayer so it can duck (fade down, not pause) instead of
  // the two overlapping. Reset to false whenever the clue modal closes.
  const [duckMusic, setDuckMusic] = useState(false);

  function openClueModal(cat, value) {
    setActiveClue({ catId: cat.id, value });
    setRevealed(false);
  }
  function closeClueModal(markUsed) {
    if (markUsed && activeClue) {
      const d = sessionRef.current.data;
      const cat = currentRoundOf(d).categories.find((c) => c.id === activeClue.catId);
      if (cat) cat.clues[activeClue.value].used = true;
      touch();
      persist();
    }
    setActiveClue(null);
    setDuckMusic(false);
  }

  /* ---------------- CLUE EDIT MODAL ---------------- */
  const [editingTarget, setEditingTarget] = useState(null); // {catId, value}
  const [editForm, setEditForm] = useState({ question: "", answer: "", timerSeconds: "", mediaClipSeconds: "", answerMediaClipSeconds: "" });
  const [mediaState, setMediaState] = useState({
    media: { mode: "url", url: "", fileRef: "", fileName: "", fileType: "" },
    answerMedia: { mode: "url", url: "", fileRef: "", fileName: "", fileType: "" },
  });
  // Snapshot of whatever file ref the clue had in Supabase storage when the
  // modal opened. Used to know what's safe to delete: if the user clears it,
  // replaces it with a new upload, or cancels out of the modal, the ref that
  // was here at open-time is the one that needs cleaning up server-side.
  const originalRefsRef = useRef({ media: "", answerMedia: "" });

  function openEditModal(cat, value) {
    const clue = cat.clues[value];
    setEditingTarget({ catId: cat.id, value });
    setEditForm({
      question: clue.question || "",
      answer: clue.answer || "",
      timerSeconds: clue.timerSeconds != null ? String(clue.timerSeconds) : "",
      // "Stop playback after N seconds" — a per-clue clip cutoff for
      // question/answer audio/video, independent of timerSeconds above
      // (which is the ANSWER timer, not a media limit). Built for
      // "1-second music round"-style clues where you want the snippet to
      // auto-stop instead of manually pausing it every time.
      mediaClipSeconds: clue.mediaClipSeconds != null ? String(clue.mediaClipSeconds) : "",
      answerMediaClipSeconds: clue.answerMediaClipSeconds != null ? String(clue.answerMediaClipSeconds) : "",
    });
    const existing = clue.mediaUrl || "";
    const media =
      isMediaRef(existing) || isDataUrl(existing)
        ? { mode: "file", url: "", fileRef: existing, fileName: "File attached (from earlier) — remove to replace", fileType: clue.mediaType || "" }
        : { mode: "url", url: existing, fileRef: "", fileName: "", fileType: "" };
    const existingAnswer = clue.answerMediaUrl || "";
    const answerMedia =
      isMediaRef(existingAnswer) || isDataUrl(existingAnswer)
        ? { mode: "file", url: "", fileRef: existingAnswer, fileName: "File attached (from earlier) — remove to replace", fileType: clue.answerMediaType || "" }
        : { mode: "url", url: existingAnswer, fileRef: "", fileName: "", fileType: "" };
    setMediaState({ media, answerMedia });
    // Remember what was actually in storage for this clue at open-time, so
    // clear/replace/cancel later know what's safe to delete from Supabase.
    originalRefsRef.current = {
      media: isMediaRef(media.fileRef) ? media.fileRef : "",
      answerMedia: isMediaRef(answerMedia.fileRef) ? answerMedia.fileRef : "",
    };
  }
  // Cancel: any file uploaded during this edit session that never got saved
  // onto the clue would otherwise sit in Supabase storage forever. Delete
  // anything currently in mediaState that wasn't there when we opened.
  function closeEditModal() {
    const m = mediaState.media;
    const am = mediaState.answerMedia;
    if (isMediaRef(m.fileRef) && m.fileRef !== originalRefsRef.current.media) {
      MediaStore.delete(m.fileRef);
    }
    if (isMediaRef(am.fileRef) && am.fileRef !== originalRefsRef.current.answerMedia) {
      MediaStore.delete(am.fileRef);
    }
    setEditingTarget(null);
  }
  async function handleMediaFile(type, file) {
    if (!file) return;
    // IndexedDB comfortably handles much larger files than the old
    // base64/localStorage approach did — this warning is now just a
    // courtesy for very large uploads.
    const proceed =
      file.size < 50 * 1024 * 1024 ||
      (await appConfirm(`"${file.name}" is ${humanSize(file.size)}. That's a large file — it may take a moment to store. Use it anyway?`));
    if (!proceed) return;
    try {
      const ref = await MediaStore.put(file);
      const fileType = detectMediaTypeFromFile(file);
      // If a file was already sitting in this field (either the clue's
      // original attachment, or one uploaded earlier in this same edit
      // session that's now being replaced again), it's about to become
      // orphaned — delete it from Supabase storage.
      setMediaState((prev) => {
        const previousRef = prev[type].fileRef;
        if (isMediaRef(previousRef) && previousRef !== ref) {
          MediaStore.delete(previousRef);
        }
        return {
          ...prev,
          [type]: { mode: "file", url: "", fileRef: ref, fileName: `📎 ${file.name} (${humanSize(file.size)})`, fileType },
        };
      });
    } catch (e) {
      appAlert("Could not store that file — your browser may be blocking local storage (e.g. private browsing mode).");
    }
  }
  function clearMediaField(type) {
    setMediaState((prev) => {
      const previousRef = prev[type].fileRef;
      if (isMediaRef(previousRef)) {
        MediaStore.delete(previousRef);
      }
      return { ...prev, [type]: { mode: "url", url: "", fileRef: "", fileName: "", fileType: "" } };
    });
  }
  function saveClue() {
    if (!editingTarget) return;
    const d = sessionRef.current.data;
    const cat = currentRoundOf(d).categories.find((c) => c.id === editingTarget.catId);
    if (cat) {
      const clue = cat.clues[editingTarget.value];
      clue.question = editForm.question.trim();
      clue.answer = editForm.answer.trim();
      const parsedTimer = parseInt(editForm.timerSeconds, 10);
      clue.timerSeconds = editForm.timerSeconds.trim() === "" || isNaN(parsedTimer) || parsedTimer <= 0 ? null : parsedTimer;
      // Media clip cutoff — same "blank/invalid/<=0 means no limit" parsing
      // as timerSeconds above. Stored per-clue so it's set once and stays
      // with the board (see useClueEditor.js header comment).
      const parsedClip = parseFloat(editForm.mediaClipSeconds);
      clue.mediaClipSeconds = editForm.mediaClipSeconds.trim() === "" || isNaN(parsedClip) || parsedClip <= 0 ? null : parsedClip;
      const parsedAnswerClip = parseFloat(editForm.answerMediaClipSeconds);
      clue.answerMediaClipSeconds = editForm.answerMediaClipSeconds.trim() === "" || isNaN(parsedAnswerClip) || parsedAnswerClip <= 0 ? null : parsedAnswerClip;
      const m = mediaState.media;
      if (m.mode === "file") {
        clue.mediaUrl = m.fileRef;
        clue.mediaType = m.fileType || "";
      } else {
        const url = m.url.trim();
        clue.mediaUrl = url;
        clue.mediaType = url ? detectMediaTypeFromUrl(url) : "";
        // Field was switched to URL mode (typed a URL directly) without
        // going through "clear" first — the file it had is now orphaned.
        if (isMediaRef(m.fileRef)) MediaStore.delete(m.fileRef);
      }
      const am = mediaState.answerMedia;
      if (am.mode === "file") {
        clue.answerMediaUrl = am.fileRef;
        clue.answerMediaType = am.fileType || "";
      } else {
        const answerUrl = am.url.trim();
        clue.answerMediaUrl = answerUrl;
        clue.answerMediaType = answerUrl ? detectMediaTypeFromUrl(answerUrl) : "";
        if (isMediaRef(am.fileRef)) MediaStore.delete(am.fileRef);
      }
      touch();
      persist();
    }
    // NOTE: deliberately does NOT clear editingTarget here anymore.
    // saveClue() is now called from two places: EditClueModal's autosave
    // debounce (on every settled keystroke) AND requestClose's flush
    // right before closing. If this closed the modal, the very first
    // autosave after a keystroke would close it out from under the host
    // mid-edit. Closing is closeEditModal's job alone (wired to the
    // "Done" button / Esc / backdrop click).
  }

  return {
    // clue play modal
    activeClue,
    setActiveClue,
    revealed,
    setRevealed,
    duckMusic,
    setDuckMusic,
    openClueModal,
    closeClueModal,
    // clue edit modal
    editingTarget,
    editForm,
    setEditForm,
    mediaState,
    setMediaState,
    openEditModal,
    closeEditModal,
    handleMediaFile,
    clearMediaField,
    saveClue,
  };
}