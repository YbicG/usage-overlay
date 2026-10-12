'use strict';
const fs = require('fs');
const path = require('path');
const { HOME, walk, baseName } = require('../util');
const { mk, parseFiles } = require('./common');
const { normalize: normalizeLimits } = require('../pushedLimits');

function roots(settings) {
  const r = new Set();
  if (process.env.CLAUDE_CONFIG_DIR) for (const d of process.env.CLAUDE_CONFIG_DIR.split(',')) r.add(path.join(d.trim(), 'projects'));
  r.add(path.join(HOME, '.claude', 'projects'));
  r.add(path.join(HOME, '.config', 'claude', 'projects'));
  for (const d of (settings.extraPaths && settings.extraPaths.claude) || []) r.add(d);
  return [...r].filter(d => fs.existsSync(d));
}

/**
 * The Claude desktop app's get_usage tool result (plan limits: 5-hour / weekly % used) is recorded in session
 * transcripts. Pull the newest one out so limits stay live without any extra permissions or credentials.
 */
function limitsFromRecord(o) {
  const c = o.message && o.message.content;
  if (!Array.isArray(c)) return null;
  for (const b of c) {
    if (b.type !== 'tool_result') continue;
    const t = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map(x => x.text || '').join('') : '');
    const i = t.indexOf('{');
    if (i < 0 || t.indexOf('"windows"') < 0) continue;
    try {
      const plan = JSON.parse(t.slice(i)).plan;
      if (plan && plan.status === 'ok' && Array.isArray(plan.windows)) {
        const n = normalizeLimits({ provider: 'claude', plan: plan.plan, windows: plan.windows }, 'claude', Date.parse(o.timestamp));
        if (n) { n.lim.source = 'claude-app'; return n.lim; }
      }
    } catch {}
  }
  return null;
}

function parse(file) {
  const events = [];
  let rl = null;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.indexOf('percentUsed') > 0 && line.indexOf('tool_result') > 0) {
      let r; try { r = JSON.parse(line); } catch { r = null; }
      const lim = r && limitsFromRecord(r);
      if (lim && (!rl || lim.asOf >= rl.asOf)) rl = lim;
      continue;
    }
    if (line.indexOf('"usage"') < 0) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const m = o.message;
    if (!m || !m.usage || o.type !== 'assistant') continue;
    if (!m.model || m.model === '<synthetic>') continue;
    const u = m.usage;
    const ts = Date.parse(o.timestamp);
    if (!ts) continue;
    events.push(mk({
      ts, provider: 'claude', model: m.model,
      input: u.input_tokens, output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens,
      project: baseName(o.cwd), session: o.sessionId,
      key: (m.id || '') + ':' + (o.requestId || ''),
    }));
  }
  return { events, extra: rl ? { rl } : null };
}

module.exports = {
  id: 'claude', name: 'Claude', color: '#d97757',
  detect: s => roots(s).length > 0,
  collect(ctx) {
    const files = [];
    for (const r of roots(ctx.settings)) walk(r, (p, n) => n.endsWith('.jsonl'), files);
    const { events, extras } = parseFiles(ctx, 'claude', files, parse);
    let limits = null;
    for (const x of extras) if (x.rl && (!limits || x.rl.asOf > limits.asOf)) limits = x.rl;
    // Streamed messages / resumed sessions repeat the same message id: keep the largest record.
    const byKey = new Map(), out = [];
    for (const e of events) {
      if (!e.key || e.key === ':') { out.push(e); continue; }
      const p = byKey.get(e.key);
      if (!p || e.output >= p.output) byKey.set(e.key, e);
    }
    for (const e of byKey.values()) out.push(e);
    return { events: out, limits };
  },
};
