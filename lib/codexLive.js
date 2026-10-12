'use strict';
// Live Codex plan limits via `codex app-server` (JSON-RPC over stdio, JSONL framing). Codex does its own
// authentication, so this module never reads or sends your token. One-shot: spawn, ask, exit.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { killTree } = require('./util');

function findCodex() {
  const c = [process.env.CODEX_BIN,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    'codex'].filter(Boolean);
  return c.find(p => p === 'codex' || fs.existsSync(p));
}

function rpc(child, method, params, id) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}

function fetchCodexLimits({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = findCodex();
    if (!bin) return reject(new Error('codex CLI not found'));
    const child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buf = '', done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(t); killTree(child); err ? reject(err) : resolve(val); };
    const t = setTimeout(() => finish(new Error('codex app-server timed out')), timeoutMs);
    child.on('error', e => finish(e));
    child.on('exit', () => finish(new Error('codex app-server exited')));
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) return finish(new Error(m.error.message || 'initialize failed'));
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
          rpc(child, 'account/rateLimits/read', undefined, 2);
        } else if (m.id === 2) {
          if (m.error) return finish(new Error(m.error.message || 'rateLimits/read failed'));
          finish(null, m.result);
        }
      }
    });
    rpc(child, 'initialize', { clientInfo: { name: 'usage-overlay', version: '1.0.0' } }, 1);
  });
}

module.exports = { fetchCodexLimits };

if (require.main === module) fetchCodexLimits().then(r => console.log(JSON.stringify(r, null, 2)), e => { console.error('ERR', e.message); process.exit(1); });
