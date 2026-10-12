'use strict';
const fs = require('fs');
const path = require('path');
const { HOME, walk, pbTry, pbGet } = require('../util');
const { mk, parseFiles } = require('./common');

const dirOf = () => path.join(HOME, '.gemini', 'antigravity', 'conversations');

const str = f => (f && f.w === 2 ? Buffer.from(f.v).toString('utf8') : '');
function usageOf(fields) {
  if (!fields) return null;
  const g = n => { const f = pbGet(fields, n); return f && f.w === 0 ? f.v : 0; };
  const u = { cacheWrite: g(1), input: g(2), output: g(3), cacheRead: g(5) };
  return u.cacheWrite + u.input + u.output + u.cacheRead > 0 ? u : null;
}

/**
 * Antigravity stores each conversation as a SQLite DB of protobuf blobs. Model calls appear in
 * steps.metadata (field 9 = usage, field 1.1 = unix seconds) and gen_metadata (field 19 = model name).
 * Field meanings are reverse-engineered from the on-disk format, so numbers are approximate.
 */
function parse(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  const session = path.basename(file).split('.')[0];
  const events = [];
  try {
    const calls = [];
    for (const r of db.prepare('select metadata from steps where metadata is not null order by idx').all()) {
      const top = pbTry(r.metadata); if (!top) continue;
      const m = pbGet(top, 9); if (!m || m.w !== 2) continue;
      const u = usageOf(pbTry(m.v)); if (!u) continue;
      const tf = pbGet(top, 1);
      const t = tf && tf.w === 2 ? pbTry(tf.v) : null;
      const secs = t && pbGet(t, 1) ? pbGet(t, 1).v : 0;
      calls.push({ u, ts: secs * 1000 });
    }
    const models = [];
    for (const r of db.prepare('select data from gen_metadata order by idx').all()) {
      const top = pbTry(r.data); if (!top) continue;
      const f1 = pbGet(top, 1);
      const inner = f1 && f1.w === 2 ? pbTry(f1.v) : null;
      models.push(str(pbGet(inner, 19)));
    }
    const fallbackTs = fs.statSync(file).mtimeMs;
    const counts = {};
    let modal = 'antigravity';
    for (const m of models) if (m) { counts[m] = (counts[m] || 0) + 1; if (counts[m] > (counts[modal] || 0)) modal = m; }
    calls.forEach((c, i) => {
      const mi = models.length ? Math.min(models.length - 1, Math.floor(i * models.length / calls.length)) : -1;
      events.push(mk({
        ts: c.ts > 1e12 ? c.ts : fallbackTs, provider: 'antigravity', model: (mi >= 0 && models[mi]) || modal,
        input: c.u.input, output: c.u.output, cacheRead: c.u.cacheRead, cacheWrite: c.u.cacheWrite, session,
      }));
    });
  } finally { db.close(); }
  return { events };
}

module.exports = {
  id: 'antigravity', name: 'Antigravity', color: '#a78bfa',
  detect: () => fs.existsSync(dirOf()),
  collect(ctx) {
    const files = walk(dirOf(), (p, n) => n.endsWith('.db'), [], 0, 1);
    return { events: parseFiles(ctx, 'antigravity', files, parse).events };
  },
};
