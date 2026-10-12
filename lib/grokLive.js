'use strict';
// Live Grok plan usage via `grok agent stdio` (ACP JSON-RPC, newline-delimited) and its `_x.ai/billing` extension
// method. Grok handles its own auth from ~/.grok; this module never reads or sends your token. One-shot.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { killTree } = require('./util');
const os = require('os');

function findGrok() {
  const c = [process.env.GROK_BIN, path.join(process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok')];
  return c.find(p => p && fs.existsSync(p));
}

function fetchGrokLimits({ timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = findGrok();
    if (!bin) return reject(new Error('grok CLI not found'));
    const child = spawn(bin, ['agent', '--no-leader', 'stdio'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buf = '', done = false, billingSent = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(t); killTree(child); err ? reject(err) : resolve(val); };
    const t = setTimeout(() => finish(new Error('grok agent timed out')), timeoutMs);
    const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    child.on('error', e => finish(e));
    child.on('exit', () => finish(new Error('grok agent exited')));
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 'init') {
          if (m.error) return finish(new Error(m.error.message || 'initialize failed'));
          if (!billingSent) { billingSent = true; send('bill', '_x.ai/billing', {}); }
        } else if (m.id === 'bill') {
          if (m.error) return finish(new Error(m.error.message || 'billing failed'));
          const cfg = (m.result && m.result.config) || {};
          const end = Date.parse(cfg.billingPeriodEnd || (cfg.currentPeriod && cfg.currentPeriod.end));
          const start = Date.parse(cfg.billingPeriodStart || (cfg.currentPeriod && cfg.currentPeriod.start));
          if (typeof cfg.creditUsagePercent !== 'number') return finish(new Error('no usage in billing response'));
          const type = cfg.currentPeriod && cfg.currentPeriod.type || '';
          finish(null, {
            source: 'grok-live', plan: (m.result.subscription_tier || '').replace(/^super/i, 'Super') || null, asOf: Date.now(),
            windows: [{ label: /WEEK/.test(type) ? 'Week' : /MONTH/.test(type) ? 'Month' : /DAY/.test(type) ? 'Day' : 'Credits', pct: cfg.creditUsagePercent, resetsAt: end || null, windowMin: end && start ? Math.round((end - start) / 60e3) : undefined }],
            prepaid: cfg.prepaidBalance && cfg.prepaidBalance.val, onDemandUsed: cfg.onDemandUsed && cfg.onDemandUsed.val,
          });
        }
      }
    });
    send('init', 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'usage-overlay', version: '1.0.0' } });
  });
}

module.exports = { fetchGrokLimits };

if (require.main === module) fetchGrokLimits().then(r => console.log(JSON.stringify(r, null, 2)), e => { console.error('ERR', e.message); process.exit(1); });
