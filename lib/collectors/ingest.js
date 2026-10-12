'use strict';
// Universal adapter: any tool (Cursor, Copilot, Windsurf, scripts...) can append JSON lines to
// ~/.usage-overlay/ingest/*.jsonl or POST to http://127.0.0.1:47615/ingest. Lines look like:
//   {"ts":"2026-01-01T12:00:00Z","provider":"cursor","model":"gpt-5","input":1200,"output":300,"cost":0.02}
const fs = require('fs');
const path = require('path');
const { HOME, walk } = require('../util');
const { mk, parseFiles } = require('./common');

const dirOf = () => path.join(HOME, '.usage-overlay', 'ingest');

function parse(file) {
  const events = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const ts = typeof o.ts === 'number' ? (o.ts < 1e12 ? o.ts * 1000 : o.ts) : Date.parse(o.ts || o.timestamp);
    if (!ts || !o.provider) continue;
    events.push(mk({
      ts, provider: String(o.provider).toLowerCase(), model: o.model,
      input: o.input ?? o.input_tokens, output: o.output ?? o.output_tokens,
      cacheRead: o.cacheRead ?? o.cache_read, cacheWrite: o.cacheWrite ?? o.cache_write, reasoning: o.reasoning,
      cost: typeof o.cost === 'number' ? o.cost : null, project: o.project, session: o.session,
    }));
  }
  return { events };
}

module.exports = {
  id: 'ingest', name: 'Custom', color: '#f59e0b', hidden: true, dir: dirOf,
  detect: () => true,
  collect(ctx) {
    fs.mkdirSync(dirOf(), { recursive: true });
    return { events: parseFiles(ctx, 'ingest', walk(dirOf(), (p, n) => n.endsWith('.jsonl')), parse).events };
  },
};
