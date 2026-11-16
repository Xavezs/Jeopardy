import { useState, useRef } from "react";
import { MediaStore, isMediaRef, detectMediaTypeFromFile, detectMediaTypeFromUrl } from "../storage";
import { isDataUrl, humanSize } from "../utils";

export function useClueEditor({ sessionRef, touch, persist, currentRoundOf, appConfirm, appAlert }) {
  // CLUE PLAY MODAL
  const [activeClue, setActiveClue] = useState(null);
  const [revealed, setRevealed] = useState(false);
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

  // CLUE EDIT MODAL
  const [editingTarget, setEditingTarget] = useState(null);
  const [editForm, setEditForm] = useState({ question: "", answer: "", timerSeconds: "", mediaClipSeconds: "", answerMediaClipSeconds: "" });
  const [mediaState, setMediaState] = useState({
    media: { mode: "url", url: "", fileRef: "", fileName: "", fileType: "" },
    answerMedia: { mode: "url", url: "", fileRef: "", fileName: "", fileType: "" },
  });
  const originalRefsRef = useRef({ media: "", answerMedia: "" });

  function openEditModal(cat, value) {
    const clue = cat.clues[value];
    setEditingTarget({ catId: cat.id, value });
    setEditForm({
      question: clue.question || "",
      answer: clue.answer || "",
      timerSeconds: clue.timerSeconds != null ? String(clue.timerSeconds) : "",
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
    originalRefsRef.current = {
      media: isMediaRef(media.fileRef) ? media.fileRef : "",
      answerMedia: isMediaRef(answerMedia.fileRef) ? answerMedia.fileRef : "",
    };
  }
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
    const proceed =
      file.size < 50 * 1024 * 1024 ||
      (await appConfirm(`"${file.name}" is ${humanSize(file.size)}. That's a large file — it may take a moment to store. Use it anyway?`));
    if (!proceed) return;
    try {
      const ref = await MediaStore.put(file);
      const fileType = detectMediaTypeFromFile(file);
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
      // Media clip cutoff
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
  }

  return {
    activeClue,
    setActiveClue,
    revealed,
    setRevealed,
    duckMusic,
    setDuckMusic,
    openClueModal,
    closeClueModal,
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