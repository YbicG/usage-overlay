'use strict';
const fs = require('fs');
const path = require('path');
const { HOME, baseName } = require('../util');
const { mk, parseFiles } = require('./common');

function dbs(settings) {
  const c = [path.join(HOME, '.local', 'share', 'opencode', 'opencode.db'),
             path.join(process.env.LOCALAPPDATA || '', 'opencode', 'opencode.db'),
             path.join(process.env.XDG_DATA_HOME || '', 'opencode', 'opencode.db'),
             ...((settings.extraPaths && settings.extraPaths.opencode) || [])];
  return [...new Set(c)].filter(f => f && fs.existsSync(f));
}

function parse(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  const events = [];
  try {
    const rows = db.prepare("select id, session_id, time_created, data from message where data like '%\"tokens\"%'").all();
    for (const r of rows) {
      let d; try { d = JSON.parse(r.data); } catch { continue; }
      if (d.role !== 'assistant' || !d.tokens) continue;
      const t = d.tokens, c = t.cache || {};
      const ts = (d.time && (d.time.completed || d.time.created)) || r.time_created;
      const local = /ollama|local|lmstudio/i.test(d.providerID || '');
      events.push(mk({
        ts, provider: 'opencode', model: [d.providerID, d.modelID].filter(Boolean).join('/'),
        input: t.input, output: t.output, reasoning: t.reasoning, cacheRead: c.read, cacheWrite: c.write,
        cost: typeof d.cost === 'number' && (d.cost > 0 || local) ? d.cost : null,
        project: baseName(d.path && d.path.cwd), session: r.session_id, key: r.id,
      }));
    }
  } finally { db.close(); }
  return { events };
}

module.exports = {
  id: 'opencode', name: 'OpenCode', color: '#38bdf8',
  detect: s => dbs(s).length > 0,
  collect(ctx) { return { events: parseFiles(ctx, 'opencode', dbs(ctx.settings), parse).events }; },
};
