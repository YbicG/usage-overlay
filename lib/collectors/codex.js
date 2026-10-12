'use strict';
const fs = require('fs');
const path = require('path');
const { HOME, walk, baseName } = require('../util');
const { mk, parseFiles } = require('./common');

function roots(settings) {
  const home = process.env.CODEX_HOME || path.join(HOME, '.codex');
  const r = [path.join(home, 'sessions'), path.join(home, 'archived_sessions'),
             ...((settings.extraPaths && settings.extraPaths.codex) || [])];
  return r.filter(d => fs.existsSync(d));
}

function parse(file) {
  const events = [];
  let model = 'gpt-5', cwd = '', prev = null, lastRL = null;
  const session = path.basename(file, '.jsonl').slice(-36);
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    const hasTok = line.indexOf('token_count') > 0;
    const hasCtx = line.indexOf('"turn_context"') > 0 || line.indexOf('"session_meta"') > 0;
    if (!hasTok && !hasCtx) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload || {};
    if (o.type === 'turn_context' || o.type === 'session_meta') {
      if (p.model) model = p.model;
      if (p.cwd) cwd = p.cwd;
      continue;
    }
    if (p.type !== 'token_count') continue;
    const ts = Date.parse(o.timestamp);
    if (p.rate_limits && (p.rate_limits.primary || p.rate_limits.secondary)) lastRL = { ts, ...p.rate_limits };
    const t = p.info && p.info.total_token_usage;
    if (!t || !ts) continue;
    const d = prev && t.total_tokens >= prev.total_tokens ? {
      input: t.input_tokens - prev.input_tokens, cached: (t.cached_input_tokens || 0) - (prev.cached_input_tokens || 0),
      output: t.output_tokens - prev.output_tokens, reasoning: (t.reasoning_output_tokens || 0) - (prev.reasoning_output_tokens || 0),
      total: t.total_tokens - prev.total_tokens,
    } : { input: t.input_tokens, cached: t.cached_input_tokens || 0, output: t.output_tokens, reasoning: t.reasoning_output_tokens || 0, total: t.total_tokens };
    prev = t;
    if (d.total <= 0) continue;
    events.push(mk({
      ts, provider: 'codex', model,
      input: Math.max(0, d.input - d.cached), cacheRead: d.cached, output: d.output, reasoning: d.reasoning,
      project: baseName(cwd), session,
    }));
  }
  return { events, extra: lastRL ? { rl: lastRL } : null };
}

module.exports = {
  id: 'codex', name: 'Codex', color: '#10a37f',
  detect: s => roots(s).length > 0,
  collect(ctx) {
    const files = [];
    for (const r of roots(ctx.settings)) walk(r, (p, n) => n.endsWith('.jsonl'), files);
    const { events, extras } = parseFiles(ctx, 'codex', files, parse);
    let rl = null;
    for (const x of extras) if (x.rl && (!rl || x.rl.ts > rl.ts)) rl = x.rl;
    let limits = null;
    if (rl) {
      const nowS = Date.now() / 1000;
      const conv = w => w && {
        pct: w.resets_at && w.resets_at < nowS ? 0 : w.used_percent,   // window already rolled over
        windowMin: w.window_minutes, resetsAt: w.resets_at ? w.resets_at * 1000 : null,
      };
      limits = { source: 'codex', plan: rl.plan_type, asOf: rl.ts, primary: conv(rl.primary), secondary: conv(rl.secondary) };
    }
    return { events, limits };
  },
};
