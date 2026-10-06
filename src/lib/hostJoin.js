// src/lib/hostJoin.js
// Joins a room as HOST. The server no longer trusts a bare `role: "host"`: it
// needs proof of who is asking, so we fetch a 60-second socket ticket over
// HTTP (where the login cookie already works, including inside Discord's
// iframe) and send it with joinRoom. Without a valid ticket for the board's
// owner/editor the server just treats this socket as a normal viewer.
import { api } from "./api";

export async function emitHostJoin(socket, roomCode) {
  let ticket = null;
  try {
    ({ ticket } = await api("/api/auth/socket-ticket"));
  } catch {
    // Not logged in (or server unreachable): join anyway; the server will refuse the host role.
  }
  socket.emit("joinRoom", { roomCode, role: "host", ticket });
}
