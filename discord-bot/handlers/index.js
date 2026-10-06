// Wires every socket handler group onto a freshly connected socket.
const groups = ['room', 'board', 'scoring', 'skills', 'powerups', 'sync', 'buzzer'];
const registrars = groups.map((g) => require(`./${g}`));

module.exports = function registerHandlers(socket, ctx) {
  console.log('Client connected:', socket.id);
  for (const register of registrars) register(socket, ctx);
};
