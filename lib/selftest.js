'use strict';
// node lib/selftest.js — runs every collector and live-limit source against this machine's real data.
const os = require('os');
const path = require('path');
const { Engine } = require('./engine');

(async () => {
  const e = new Engine({ cacheFile: path.join(os.tmpdir(), 'usage-overlay-selftest-cache.json'), settings: {} });
  const t0 = Date.now();
  await e.snapshot(n => process.stdout.write('reading ' + n + '\n'));
  // Live limit polls run in the background: wait for them before taking the snapshot we report.
  for (let i = 0; i < 80 && Object.values(e.live).some(x => x.busy); i++) await new Promise(r => setTimeout(r, 500));
  for (const [id, st] of Object.entries(e.live)) console.log(`live ${id.padEnd(12)} ${st.err ? 'ERROR ' + st.err : st.val ? 'ok' : st.at ? 'no data (app not running?)' : 'off'}`);
  const s = await e.snapshot();
  e.saveCache(true);
  console.log(`\n${s.eventCount} events in ${Date.now() - t0}ms; errors:`, s.errors);
  const f = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
  for (const p of s.providers) {
    console.log(`${p.name.padEnd(12)} today ${f(p.ranges.today.tokens).padStart(8)} $${p.ranges.today.cost.toFixed(2).padStart(7)} | 30d ${f(p.ranges.d30.tokens).padStart(8)} $${p.ranges.d30.cost.toFixed(2).padStart(8)} | ${p.planLabel || '-'}`,
      p.gauges.map(g => `${g.group ? g.group + ' ' : ''}${g.label} ${Math.round(100 - g.pct)}% left [${g.source || 'cap'}]`).join(', '));
  }
  console.log('forecast', s.forecast);
  process.exit(0);
})();
