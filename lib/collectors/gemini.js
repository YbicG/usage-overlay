'use strict';
const fs = require('fs');
const path = require('path');
const { HOME, walk, baseName, readJsonSafe } = require('../util');
const { mk, parseFiles } = require('./common');

const dirOf = () => path.join(HOME, '.gemini', 'tmp');

// Gemini CLI chat sessions: ~/.gemini/tmp/<project-hash>/chats/session-*.json with messages[].tokens
function parse(file) {
  const j = readJsonSafe(file, null);
  if (!j || !Array.isArray(j.messages)) return { events: [] };
  const events = [];
  for (const m of j.messages) {
    if (!m.tokens) continue;
    const ts = Date.parse(m.timestamp); if (!ts) continue;
    const t = m.tokens, cached = t.cached || 0;
    events.push(mk({
      ts, provider: 'gemini', model: m.model || 'gemini', input: Math.max(0, (t.input || 0) - cached), cacheRead: cached,
      output: (t.output || 0) + (t.tool || 0), reasoning: t.thoughts,
      session: j.sessionId, project: baseName(path.dirname(path.dirname(file))).slice(0, 8), key: m.id,
    }));
  }
  return { events };
}

module.exports = {
  id: 'gemini', name: 'Gemini CLI', color: '#4285f4',
  detect: () => fs.existsSync(dirOf()),
  collect(ctx) {
    const files = walk(dirOf(), (p, n) => /^session-.*\.json$/.test(n));
    return { events: parseFiles(ctx, 'gemini', files, parse).events };
  },
};
