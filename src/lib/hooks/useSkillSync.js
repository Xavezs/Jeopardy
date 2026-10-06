// lib/hooks/useSkillSync.js
import { useEffect, useRef, useState, useCallback } from "react";
import { useSocket } from "../SocketContext";

/* =========================================================================
   useSkillSync
   Shared by host AND players. Tracks which skills each player has already
   spent this game (server: room.skillsUsed) and the skill cutscene
   currently playing.

   `me` — { discordUserId } on the player side; null on the host.
   `activeSkill` — { skillId, effect, discordUserId, teamId, deltas } while a
   cutscene should be showing, else null. Render <SkillOverlay> from it and
   call `clearActiveSkill()` in its onDone.
   `castSkill(skillId)` — PLAYER-SIDE. Only fires the request; the server
   validates ownership, one-use-per-win and the Final Jeopardy lockout
   and answers with `errorMsg` if it refuses.
   `skillsUsed` — { [discordUserId]: string[] }
   `skillsGranted` — { [discordUserId]: string[] } skills won from a Power-ups spin.
   A player can only cast a skill once it appears here for them.
   `runPowerDraw()` — HOST-SIDE, used by the Randomizer's Power-ups tab. Asks
   the server to roll every unlocked player's grant chance and resolves with
   `{ winners: [{ discordUserId, skillId, skillName }] }` or `{ error }`. The
   Randomizer then builds the slot-machine result from the winners and
   broadcasts it like any other spin.

   Score changes are NOT applied here: the host applies `activeSkill.deltas`
   (see JeopardyBoard), since the host owns scores. Each skill use carries an
   `eventId`; the host applies it once, then calls `ackSkillDeltas(eventId)`.
   `pendingSkillDeltas` — [{ id, deltas }] the server resends to a host that
   (re)joins before acknowledging, so damage is not lost if the host's tab was
   closed during the cutscene.
   ========================================================================= */
export function useSkillSync(roomCode, me) {
  const { socket } = useSocket();
  const [skillsUsed, setSkillsUsed] = useState({});
  const [skillsGranted, setSkillsGranted] = useState({});
  const [powerupsGranted, setPowerupsGranted] = useState({});
  const [activeSkill, setActiveSkill] = useState(null);
  // Score deltas the server still owes the HOST (sent on host join/reconnect).
  const [pendingSkillDeltas, setPendingSkillDeltas] = useState([]);
  // Power-up (2x / Shield / Steal / Freeze / Hint / Re-Buzz) live state.
  const [armedPowerups, setArmedPowerups] = useState([]);
  const [frozenTeams, setFrozenTeams] = useState({});
  const [powerupNotice, setPowerupNotice] = useState(null);
  const [hint, setHint] = useState(null);

  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;
  const meRef = useRef(me);
  meRef.current = me;

  useEffect(() => {
    if (!socket) return;
    const handleUsedUpdate = (used) => setSkillsUsed(used || {});
    const handleSkillUsed = (payload) => setActiveSkill(payload || null);
    const handleGrantedUpdate = (granted) => setSkillsGranted(granted || {});
    socket.on("skillsUsedUpdate", handleUsedUpdate);
    socket.on("skillUsed", handleSkillUsed);
    const handleSkillPending = (list) => setPendingSkillDeltas(Array.isArray(list) ? list : []);
    socket.on("skillDeltasPending", handleSkillPending);
    const handlePowerupsUpdate = (items) => setPowerupsGranted(items || {});
    socket.on("skillsGrantedUpdate", handleGrantedUpdate);
    socket.on("powerupsGrantedUpdate", handlePowerupsUpdate);
    const handleArmed = (list) => setArmedPowerups(Array.isArray(list) ? list : []);
    const handleFrozen = (map) => setFrozenTeams(map || {});
    const handleNotice = (n) => setPowerupNotice(n || null);
    const handleHint = (h) => setHint(h || null);
    socket.on("powerupsArmedUpdate", handleArmed);
    socket.on("frozenTeamsUpdate", handleFrozen);
    socket.on("powerupUsed", handleNotice);
    socket.on("powerupHint", handleHint);
    return () => {
      socket.off("powerupsArmedUpdate", handleArmed);
      socket.off("frozenTeamsUpdate", handleFrozen);
      socket.off("powerupUsed", handleNotice);
      socket.off("powerupHint", handleHint);
      socket.off("skillsUsedUpdate", handleUsedUpdate);
      socket.off("skillUsed", handleSkillUsed);
      socket.off("skillDeltasPending", handleSkillPending);
      socket.off("skillsGrantedUpdate", handleGrantedUpdate);
      socket.off("powerupsGrantedUpdate", handlePowerupsUpdate);
    };
  }, [socket]);

  // HOST-SIDE: tell the server a skill's deltas were applied and persisted.
  const ackSkillDeltas = useCallback(
    (eventId) => {
      const code = roomCodeRef.current;
      if (!code || !socket || !eventId) return;
      socket.emit("skillDeltasApplied", { roomCode: code, eventId });
    },
    [socket]
  );

  const castSkill = useCallback(
    (skillId) => {
      const code = roomCodeRef.current;
      if (!code || !socket) return;
      socket.emit("useSkill", {
        roomCode: code,
        skillId,
        discordUserId: meRef.current?.discordUserId ?? null,
      });
    },
    [socket]
  );

  const clearActiveSkill = useCallback(() => setActiveSkill(null), []);
  const clearPowerupNotice = useCallback(() => setPowerupNotice(null), []);
  const clearHint = useCallback(() => setHint(null), []);

  // PLAYER-SIDE. Activates one granted power-up (works during a clue too).
  // Resolves { ok } or { error } — the server also emits `errorMsg`.
  const activatePowerup = useCallback((label, targetTeamId = null) => {
    const code = roomCodeRef.current;
    const uid = meRef.current?.discordUserId;
    if (!code || !socket || !uid) return Promise.resolve({ error: "Not connected." });
    return new Promise((resolve) => {
      socket.timeout(5000).emit("usePowerup", { roomCode: code, label, discordUserId: uid, targetTeamId }, (err, res) => {
        if (err) resolve({ error: "The server did not answer." });
        else resolve(res || { error: "Empty response." });
      });
    });
  }, [socket]);

  // HOST-SIDE. Tells the server an armed 2x / Shield was just applied.
  const consumeArmed = useCallback((id) => {
    const code = roomCodeRef.current;
    if (!code || !socket) return;
    socket.emit("hostConsumeArmed", { roomCode: code, id });
  }, [socket]);

  const runPowerDraw = useCallback(() => {
    const code = roomCodeRef.current;
    if (!code || !socket) return Promise.resolve({ error: "Not connected." });
    return new Promise((resolve) => {
      socket.timeout(5000).emit("hostPowerDraw", { roomCode: code }, (err, res) => {
        if (err) resolve({ error: "The server did not answer the power-up roll." });
        else resolve(res || { error: "Empty response." });
      });
    });
  }, [socket]);

  // HOST-SIDE. Called when the host confirms the spin ("Apply Power-ups"):
  // the server only now unlocks the previewed skills and hands every item to
  // its player (each player receives just their own).
  const runPowerApply = useCallback((playerPowerups) => {
    const code = roomCodeRef.current;
    if (!code || !socket) return Promise.resolve({ error: "Not connected." });
    return new Promise((resolve) => {
      socket.timeout(5000).emit("hostPowerApply", { roomCode: code, playerPowerups }, (err, res) => {
        if (err) resolve({ error: "The server did not answer." });
        else resolve(res || { error: "Empty response." });
      });
    });
  }, [socket]);

  return {
    skillsUsed,
    skillsGranted,
    powerupsGranted,
    armedPowerups,
    frozenTeams,
    powerupNotice,
    clearPowerupNotice,
    hint,
    clearHint,
    activatePowerup,
    consumeArmed,
    runPowerApply,
    activeSkill,
    pendingSkillDeltas,
    ackSkillDeltas,
    castSkill,
    clearActiveSkill,
    runPowerDraw,
  };
}