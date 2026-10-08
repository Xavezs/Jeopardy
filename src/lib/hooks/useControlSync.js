import { useEffect, useState, useRef, useCallback } from "react";
import { useSocket } from "../SocketContext";

export const OPEN_CONTROL = "__OPEN__";

export function useControlSync(roomCode, me, { onClueSelected, onLocalControlChanged } = {}) {
  const [controlDiscordUserId, setControlDiscordUserId] = useState(null);
  const { socket, connected } = useSocket();
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  const onClueSelectedRef = useRef(onClueSelected);
  onClueSelectedRef.current = onClueSelected;
  const onLocalControlChangedRef = useRef(onLocalControlChanged);
  onLocalControlChangedRef.current = onLocalControlChanged;

  const meRef = useRef(me);
  meRef.current = me;

  useEffect(() => {
    if (!socket) return;

    const handleConnect = () => {
      if (roomCodeRef.current) socket.emit("joinRoom", roomCodeRef.current);
    };
    const handleControlChanged = ({ controlDiscordUserId: id }) => {
      setControlDiscordUserId(id ?? null);
    };
    const handleClueSelected = (payload) => {
      onClueSelectedRef.current?.(payload);
    };

    socket.on("connect", handleConnect);
    socket.on("controlChanged", handleControlChanged);
    socket.on("clueSelected", handleClueSelected);

    if (socket.connected && roomCodeRef.current) {
      socket.emit("joinRoom", roomCodeRef.current);
    }

    return () => {
      socket.off("connect", handleConnect);
      socket.off("controlChanged", handleControlChanged);
      socket.off("clueSelected", handleClueSelected);
    };
  }, [socket]);

  useEffect(() => {
    if (roomCode && socket?.connected) {
      socket.emit("joinRoom", roomCode);
    }
  }, [roomCode, socket]);

  const selectClue = useCallback(({ catId, value }) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socket) return;
    socket.emit("selectClue", {
      roomCode,
      catId,
      value,
      discordUserId: meRef.current?.discordUserId ?? null,
    });
  }, [socket]);

  const judgeAnswer = useCallback((discordUserId, correct) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socket) return;
    socket.emit("judgeAnswer", { roomCode, discordUserId, correct });
    if (correct) onLocalControlChangedRef.current?.(discordUserId || null);
  }, [socket]);

  const hostSetControl = useCallback((discordUserId) => {
    const roomCode = roomCodeRef.current;
    if (!roomCode || !socket) return;
    socket.emit("hostSetControl", { roomCode, discordUserId });
    onLocalControlChangedRef.current?.(discordUserId || null);
  }, [socket]);

  const isMyTurn = controlDiscordUserId === OPEN_CONTROL || (!!controlDiscordUserId && controlDiscordUserId === me?.discordUserId);

  return {
    controlDiscordUserId,
    isMyTurn,
    connected,
    selectClue,
    judgeAnswer,
    hostSetControl,
  };
}