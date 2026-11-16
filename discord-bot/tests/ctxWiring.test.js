const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'bot-server.js'), 'utf8');
const ctxBody = server.match(/const ctx = \{([\s\S]*?)\n\};/)[1];
const provided = new Set(ctxBody.split(/[\s,]+/).filter(Boolean));

test('every ctx name destructured by a handler is provided', () => {
  const dir = path.join(root, 'handlers');
  for (const f of fs.readdirSync(dir).filter((x) => x !== 'index.js')) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = src.match(/const \{([^}]*)\} = ctx;/);
    if (!m) continue;
    for (const name of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      assert.ok(provided.has(name), `handlers/${f} needs ctx.${name} but bot-server.js does not provide it`);
    }
  }
});
