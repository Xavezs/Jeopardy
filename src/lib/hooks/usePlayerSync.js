import { useEffect, useState, useRef } from "react";
import { useSocket } from "../SocketContext";

export function usePlayerSync(roomCode, me, onRoomCodeChanged) {
  const [boardData, setBoardData] = useState(null);
  const { socket, connected } = useSocket();
  const [activeClue, setActiveClue] = useState(null);
  const [joinedTeam, setJoinedTeam] = useState(null);
  const [revealedCats, setRevealedCats] = useState([]);
  const [roundBanner, setRoundBanner] = useState(null);
  const [players, setPlayers] = useState([]);
  const [bgm, setBgm] = useState(null);
  const [randomizer, setRandomizer] = useState(null);
  const [playerStats, setPlayerStats] = useState({});
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;
  const meRef = useRef(me);
  meRef.current = me;
  const onRoomCodeChangedRef = useRef(onRoomCodeChanged);
  onRoomCodeChangedRef.current = onRoomCodeChanged;
  // Set once leaveGame() is called
  const hasLeftRef = useRef(false);

  function sendJoin(socket) {
    if (hasLeftRef.current) return;
    const code = roomCodeRef.current;
    if (!code) return;
    const currentMe = meRef.current;
    if (currentMe?.username) {
      socket.emit("joinAsPlayer", {
        roomCode: code,
        teamName: currentMe.username,
        discordUser: currentMe.discordUser || null,
      });
    } else {
      socket.emit("joinRoom", code);
    }
  }

  useEffect(() => {
    if (!socket) return;

    const handleConnect = () => {
      if (hasLeftRef.current) return;
      sendJoin(socket);
    };
    const handleBoardUpdate = ({ data }) => setBoardData(data);
    const handleActiveClueUpdate = (payload) => setActiveClue(payload || null);
    const handleJoinedTeam = (payload) => setJoinedTeam(payload || null);
    const handleRevealedCatsUpdate = (ids) => setRevealedCats(Array.isArray(ids) ? ids : []);
    const handleRoundBannerUpdate = (payload) => setRoundBanner(payload || null);
    const handlePlayersUpdate = (list) => setPlayers(Array.isArray(list) ? list : []);
    const handleBgmUpdate = (payload) => setBgm(payload || null);
    const handleRandomizerUpdate = (payload) => setRandomizer(payload || null);
    const handleStatsUpdate = (stats) => setPlayerStats(stats || {});
    const handleRoomCodeChanged = ({ roomCode: nextRoomCode }) => {
      if (typeof nextRoomCode === "string" && nextRoomCode.trim()) {
        onRoomCodeChangedRef.current?.(nextRoomCode.trim().toUpperCase());
      }
    };

    socket.on("connect", handleConnect);
    socket.on("boardUpdate", handleBoardUpdate);
    socket.on("activeClueUpdate", handleActiveClueUpdate);
    socket.on("joinedTeam", handleJoinedTeam);
    socket.on("revealedCatsUpdate", handleRevealedCatsUpdate);
    socket.on("roundBannerUpdate", handleRoundBannerUpdate);
    socket.on("playersUpdate", handlePlayersUpdate);
    socket.on("bgmUpdate", handleBgmUpdate);
    socket.on("randomizerUpdate", handleRandomizerUpdate);
    socket.on("statsUpdate", handleStatsUpdate);
    socket.on("roomCodeChanged", handleRoomCodeChanged);

    if (socket.connected) handleConnect();

    return () => {
      socket.off("connect", handleConnect);
      socket.off("boardUpdate", handleBoardUpdate);
      socket.off("activeClueUpdate", handleActiveClueUpdate);
      socket.off("joinedTeam", handleJoinedTeam);
      socket.off("revealedCatsUpdate", handleRevealedCatsUpdate);
      socket.off("roundBannerUpdate", handleRoundBannerUpdate);
      socket.off("playersUpdate", handlePlayersUpdate);
      socket.off("bgmUpdate", handleBgmUpdate);
      socket.off("randomizerUpdate", handleRandomizerUpdate);
      socket.off("statsUpdate", handleStatsUpdate);
      socket.off("roomCodeChanged", handleRoomCodeChanged);
    };
  }, [socket]);

  useEffect(() => {
    if (roomCode && socket?.connected) {
      sendJoin(socket);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, socket, me?.username, me?.discordUser?.id, me?.discordUser?.avatarUrl]);

  // Deliberate leave
  function leaveGame() {
    hasLeftRef.current = true;
    const code = roomCodeRef.current;

    setJoinedTeam(null);

    if (!socket?.connected || !code) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      socket.emit("leaveGame", code, () => finish());
      setTimeout(finish, 1500);
    });
  }

  return { boardData, connected, activeClue, joinedTeam, revealedCats, roundBanner, players, bgm, randomizer, playerStats, leaveGame };
}