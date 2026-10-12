'use strict';
// Any process can report plan limits it can see (e.g. a Claude session reading its usage card):
//   POST http://127.0.0.1:47615/limits
//   {"provider":"claude","plan":"Pro","windows":[{"label":"5-hour","percentUsed":12,"resetsAt":"2026-10-10T02:50:00Z"}]}
// or write the same JSON to ~/.usage-overlay/limits/<provider>.json
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.usage-overlay', 'limits');
const toMs = v => (v == null ? null : typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v) || null);

function shortLabel(l) {
  l = String(l || 'limit');
  if (/5.?-?\s?hour|session/i.test(l)) return '5h';
  if (/week/i.test(l)) return /opus|sonnet|model/i.test(l) && !/all/i.test(l) ? 'Wk·' + (l.match(/opus|sonnet/i) || ['model'])[0] : 'Week';
  return l.replace(/ limit$/i, '');
}

function normalize(o, fallbackId, fallbackAsOf) {
  const id = String(o.provider || fallbackId || '').toLowerCase();
  if (!id || !Array.isArray(o.windows)) return null;
  const windows = o.windows.map(w => ({
    label: shortLabel(w.label),
    pct: Number(w.pct ?? w.percentUsed ?? w.used_percent ?? w.utilization),
    resetsAt: toMs(w.resetsAt ?? w.resets_at),
    windowMin: w.windowMin,
    group: w.group,
  })).filter(w => Number.isFinite(w.pct));
  if (!windows.length) return null;
  return { id, lim: { source: 'pushed', plan: o.plan || null, asOf: toMs(o.asOf) || fallbackAsOf || Date.now(), windows } };
}

function writePushedLimits(o) {
  const n = normalize(o);
  if (!n) return false;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, n.id.replace(/[^a-z0-9_-]/g, '') + '.json'), JSON.stringify({ provider: n.id, plan: n.lim.plan, asOf: new Date().toISOString(), windows: o.windows }, null, 2));
  return true;
}

function readPushedLimits() {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const full = path.join(DIR, f);
      const n = normalize(JSON.parse(fs.readFileSync(full, 'utf8')), path.basename(f, '.json'), fs.statSync(full).mtimeMs);
      if (n) out[n.id] = n.lim;
    } catch {}
  }
  return out;
}

module.exports = { readPushedLimits, writePushedLimits, normalize, DIR };
