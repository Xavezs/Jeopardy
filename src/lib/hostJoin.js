import { api } from "./api";

export async function emitHostJoin(socket, roomCode) {
  let ticket = null;
  try {
    ({ ticket } = await api("/api/auth/socket-ticket"));
  } catch {
  }
  socket.emit("joinRoom", { roomCode, role: "host", ticket });
}
