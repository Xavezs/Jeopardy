import { useEffect, useRef, useState, useCallback } from "react";
import { useSocket } from "../SocketContext";

export function useSkillSync(roomCode, me) {
  const { socket } = useSocket();
  const [skillsUsed, setSkillsUsed] = useState({});
  const [skillsGranted, setSkillsGranted] = useState({});
  const [powerupsGranted, setPowerupsGranted] = useState({});
  const [activeSkill, setActiveSkill] = useState(null);
  const [pendingSkillDeltas, setPendingSkillDeltas] = useState([]);
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