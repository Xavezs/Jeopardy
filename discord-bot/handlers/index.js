const groups = ['room', 'board', 'scoring', 'skills', 'powerups', 'sync', 'buzzer'];
const registrars = groups.map((g) => require(`./${g}`));

const MAX_EVENTS_PER_SECOND = 50;

module.exports = function registerHandlers(socket, ctx) {
  console.log('Client connected:', socket.id);

  let windowStart = Date.now();
  let count = 0;
  socket.use((_packet, next) => {
    if (socket.isHost) return next();
    const now = Date.now();
    if (now - windowStart >= 1000) { windowStart = now; count = 0; }
    if (++count > MAX_EVENTS_PER_SECOND) return next(new Error('Rate limited'));
    return next();
  });

  for (const register of registrars) register(socket, ctx);
};
