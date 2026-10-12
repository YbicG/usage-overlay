'use strict';
const { sigOf } = require('../util');

/** Normalized usage event. All token counts are non-overlapping buckets. */
function mk(o) {
  return {
    ts: o.ts, provider: o.provider, model: o.model || 'unknown',
    input: o.input || 0, output: o.output || 0,
    cacheRead: o.cacheRead || 0, cacheWrite: o.cacheWrite || 0, reasoning: o.reasoning || 0,
    cost: o.cost == null ? null : o.cost,           // null => estimate from pricing table
    project: o.project || '', session: o.session || '', key: o.key || null,
  };
}

/**
 * Parse each file at most once per (size,mtime) signature. `parse(file)` returns {events, extra?}.
 * Returns {events, extras:[...]} and prunes entries for files that vanished.
 */
function parseFiles(ctx, ns, files, parse) {
  const store = (ctx.cache[ns] = ctx.cache[ns] || {});
  const seen = new Set(files);
  for (const k of Object.keys(store)) if (!seen.has(k)) { delete store[k]; ctx.dirty = true; }
  const events = [], extras = [];
  for (const f of files) {
    const sig = sigOf(f);
    if (!sig) continue;
    let ent = store[f];
    if (!ent || ent.sig !== sig) {
      let r;
      try { r = parse(f) || { events: [] }; } catch (err) { r = { events: [], err: String(err && err.message || err) }; }
      ent = store[f] = { sig, events: r.events, extra: r.extra };
      ctx.dirty = true;
    }
    for (const e of ent.events) events.push(e);
    if (ent.extra) extras.push(ent.extra);
  }
  return { events, extras };
}

module.exports = { mk, parseFiles };
