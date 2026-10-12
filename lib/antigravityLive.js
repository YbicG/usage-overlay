'use strict';
// Live Antigravity model quotas. While the Antigravity app is open it runs a local language server; we find it
// (process command line carries its CSRF token, which only grants access to that loopback server), then call
// GetUserStatus on 127.0.0.1. No Google credentials are read or sent by us. Returns null when the app isn't running.
const { execFile } = require('child_process');
const https = require('https');
const http = require('http');

function ps(script, timeout = 12000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout, windowsHide: true, maxBuffer: 4e6 },
      (err, out) => (err ? reject(err) : resolve(out)));
  });
}

function tasklistHas(image) {
  return new Promise(resolve => execFile('tasklist', ['/FI', 'IMAGENAME eq ' + image, '/NH', '/FO', 'CSV'], { windowsHide: true, timeout: 5000 },
    (err, out) => resolve(!err && /language_server/i.test(out || ''))));
}

async function findServers() {
  if (process.platform !== 'win32') return [];
  if (!(await tasklistHas('language_server*'))) return [];          // cheap check first; PowerShell/CIM is ~1s of CPU
  const out = await ps(`
$r = @()
Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'language_server*' -and $_.CommandLine -match 'csrf_token' } | ForEach-Object {
  $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $_.ProcessId -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort)
  $r += [pscustomobject]@{ pid = $_.ProcessId; cmd = $_.CommandLine; ports = $ports }
}
ConvertTo-Json -InputObject @($r) -Compress -Depth 4`);
  const t = out.trim();
  if (!t) return [];
  const j = JSON.parse(t);
  return (Array.isArray(j) ? j : [j]).map(s => {
    const m = /--?csrf_token[= ]+"?([A-Za-z0-9\-_]+)"?/.exec(s.cmd);
    return m ? { pid: s.pid, token: m[1], ports: [].concat(s.ports || []) } : null;
  }).filter(Boolean);
}

function post(port, tls, token, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const mod = tls ? https : http;
    const req = mod.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST', rejectUnauthorized: false, timeout: 6000,
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': token, 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let b = ''; res.on('data', d => (b += d));
      res.on('end', () => (res.statusCode === 200 ? resolve(b) : reject(new Error('HTTP ' + res.statusCode))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

const REQ = { metadata: { ideName: 'antigravity', extensionName: 'antigravity', ideVersion: 'unknown', locale: 'en' } };
const PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const SUMMARY_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';

// RetrieveUserQuotaSummary is what Antigravity's own "Models & Usage" panel shows: per model group, a 5h and a weekly bucket.
function summaryToLimits(j) {
  const groups = (j.response || j).groups || [];
  const windows = [];
  for (const g of groups) {
    const name = String(g.displayName || 'Models').replace(/\s+models$/i, '').replace(/\s+and\s+/i, '/');
    for (const b of g.buckets || []) {
      if (typeof b.remainingFraction !== 'number') continue;
      windows.push({ group: name, label: b.window === 'weekly' ? 'Week' : b.window === '5h' ? '5h' : String(b.window || b.displayName), pct: Math.round((1 - b.remainingFraction) * 1000) / 10, resetsAt: b.resetTime ? Date.parse(b.resetTime) : null });
    }
  }
  return windows.length ? { windows } : null;
}

// A bucket that resets within ~5h is the 5-hour window; within ~8 days a weekly one.
function horizonLabel(resetsAt) {
  const h = resetsAt ? (resetsAt - Date.now()) / 3600e3 : 0;
  return h <= 5.5 ? '5h' : h <= 24 * 8 ? 'Week' : 'Month';
}

function toLimits(j) {
  const us = j.userStatus || j;
  const cfgs = (us.cascadeModelConfigData && us.cascadeModelConfigData.clientModelConfigs) || [];
  const windows = [];
  for (const c of cfgs) {
    const q = c.quotaInfo;
    if (!q || typeof q.remainingFraction !== 'number') continue;
    windows.push({ label: String(c.label || c.modelOrAlias && c.modelOrAlias.model || 'model'), pct: Math.round((1 - q.remainingFraction) * 1000) / 10, resetsAt: q.resetTime ? Date.parse(q.resetTime) : null });
  }
  if (!windows.length) return null;
  // Models share quota buckets (same fraction + reset time): collapse each bucket into one gauge
  const groups = new Map();
  for (const w of windows) { const k = w.pct + '|' + w.resetsAt; (groups.get(k) || groups.set(k, []).get(k)).push(w); }
  const list = [...groups.values()].map(g => ({ label: groups.size === 1 ? horizonLabel(g[0].resetsAt) : g[0].label.replace(/\s*\(.*\)/, '') + (g.length > 1 ? ' +' + (g.length - 1) : ''), pct: g[0].pct, resetsAt: g[0].resetsAt, models: g.map(x => x.label) })).sort((a, b) => b.pct - a.pct);
  return { source: 'antigravity-live', plan: us.planStatus && us.planStatus.planInfo && us.planStatus.planInfo.planName || (us.userTier && us.userTier.name) || null, asOf: Date.now(), windows: list.slice(0, 3) };
}

async function fetchAntigravityLimits() {
  const servers = await findServers();
  if (!servers.length) return null;                               // app not running
  let lastErr = null;
  for (const s of servers) for (const port of s.ports) for (const tls of [true, false]) {
    try {
      let lim = null;
      try { const sm = summaryToLimits(JSON.parse(await post(port, tls, s.token, SUMMARY_PATH, REQ))); if (sm) lim = { source: 'antigravity-live', plan: null, asOf: Date.now(), windows: sm.windows }; } catch (e) { if (/EPROTO|ECONNRESET|wrong version/i.test(String(e.message))) throw e; }
      const j = JSON.parse(await post(port, tls, s.token, PATH, REQ));
      const base = toLimits(j);
      if (lim) { lim.plan = base && base.plan || (j.userStatus && j.userStatus.userTier && j.userStatus.userTier.name) || null; return lim; }
      lim = base;
      if (lim) return lim;
      lastErr = new Error('no quota info in GetUserStatus response');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Antigravity language server not reachable');
}

module.exports = { fetchAntigravityLimits, toLimits, findServers };

if (require.main === module) fetchAntigravityLimits().then(r => console.log(JSON.stringify(r, null, 2)), e => { console.error('ERR', e.message); process.exit(1); });
