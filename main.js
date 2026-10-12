'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, screen, nativeImage, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { Worker } = require('worker_threads');
const { writePushedLimits } = require('./lib/pushedLimits');

const INGEST_PORT = 47615;
const INGEST_DIR = path.join(os.homedir(), '.usage-overlay', 'ingest');
const MODES = ['full', 'compact', 'pill'];
const BASE = { full: [500, 780], compact: [390, 420], pill: [330, 34] };

const DEFAULTS = {
  mode: 'full', opacity: 0.94, scale: 1, alwaysOnTop: true, clickThrough: false, accent: '#7c9cff',
  metric: 'cost', period: 'today', refreshSec: 5, claudeLiveLimits: false, monthlyBudget: 0,
  providersEnabled: {}, budgets: {}, pricing: {}, extraPaths: {}, bounds: null, tab: 'models', startHidden: false,
};

// Same data folder whether run from source or installed (the installed app's name differs), so settings carry over.
app.setPath('userData', process.env.UO_USERDATA || (process.env.UO_SHOT ? path.join(process.env.UO_SHOT, '_ud') : path.join(app.getPath('appData'), 'usage-overlay')));
if (process.platform === 'win32') app.setAppUserModelId('com.usageoverlay.app');
let win = null, tray = null, worker = null, settings = null, lastSnap = null, status = 'Starting…', quitting = false;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch {}
  settings = { ...DEFAULTS, ...s };
  try { settings.startWithWindows = app.getLoginItemSettings(loginArgs()).openAtLogin; } catch {}
}
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {}
  }, 300);
}

// Unpackaged, Windows must launch electron.exe *with this app's folder*, or login would start a bare Electron.
function loginArgs() { return app.isPackaged ? {} : { path: process.execPath, args: [path.resolve(__dirname)] }; }

/* ---------- procedural icons (no binary assets needed) ---------- */
function ringIcon(size, pct) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2, ro = size * 0.47, ri = size * 0.30;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x - c, dy = y - c, d = Math.hypot(dx, dy);
    let a = 0, r = 225, g = 225, b = 225;
    if (d <= ro && d >= ri) {
      const ang = (Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI);
      if (ang <= pct) { a = 255; } else { a = 60; r = g = b = 150; }
      const edge = Math.min(ro - d, d - ri); if (edge < 1) a *= Math.max(0, edge);
    }
    const i = (y * size + x) * 4; buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a;   // BGRA
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function appIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  return img.isEmpty() ? ringIcon(64, 0.7) : img;
}

/* ---------- window ---------- */
function targetSize() {
  const [w, h] = BASE[settings.mode];
  return [Math.round(w * settings.scale), Math.round(h * settings.scale)];
}

function defaultPosition(w, h) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - w - 16, y: wa.y + 16 };
}

function clampToDisplay(b) {
  const d = screen.getDisplayMatching(b).workArea;
  return {
    ...b,
    x: Math.min(Math.max(b.x, d.x - b.width + 80), d.x + d.width - 80),
    y: Math.min(Math.max(b.y, d.y), d.y + d.height - 40),
  };
}

function createWindow() {
  const [w, h] = targetSize();
  const pos = settings.bounds ? clampToDisplay({ ...settings.bounds, width: w, height: h }) : { ...defaultPosition(w, h), width: w, height: h };
  win = new BrowserWindow({
    ...pos, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, skipTaskbar: true, show: false, title: 'Usage Overlay', icon: appIcon(),
    alwaysOnTop: settings.alwaysOnTop, fullscreenable: false, maximizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  applyOnTop();
  win.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(settings.scale);
    pushState();
    if (lastSnap) win.webContents.send('snapshot', lastSnap);
  });
  win.once('ready-to-show', () => { if (!settings.startHidden) win.show(); });
  win.on('moved', () => { const b = win.getBounds(); settings.bounds = { x: b.x, y: b.y }; saveSettings(); });
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
}

function applyOnTop() {
  if (!win) return;
  // 'screen-saver' keeps the overlay above borderless-fullscreen games/apps
  win.setAlwaysOnTop(settings.alwaysOnTop, settings.alwaysOnTop ? 'screen-saver' : 'normal');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function applyGeometry() {
  if (!win) return;
  const [w, h] = targetSize();
  const b = win.getBounds();
  win.setResizable(true);
  win.setBounds({ x: b.x, y: b.y, width: w, height: h });
  win.setResizable(false);
  win.webContents.setZoomFactor(settings.scale);
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('state', { settings, status, ingest: { port: INGEST_PORT, dir: INGEST_DIR } });
  refreshTray();
}

function update(patch, { geometry = false, workerSync = false } = {}) {
  Object.assign(settings, patch);
  saveSettings();
  if ('alwaysOnTop' in patch) applyOnTop();
  if ('clickThrough' in patch) win.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
  if (geometry || 'mode' in patch || 'scale' in patch) applyGeometry();
  if (workerSync) syncWorker();
  if ('startWithWindows' in patch) app.setLoginItemSettings({ openAtLogin: !!patch.startWithWindows, ...loginArgs() });
  pushState();
}

/** Re-read every log and re-check every live plan limit right now. */
function manualRefresh() {
  if (worker) worker.postMessage({ type: 'refresh', force: true });
  if (win && !win.isDestroyed()) win.webContents.send('refreshing');
}

function toggleVisible() {
  if (!win) return;
  if (win.isVisible()) win.hide(); else { win.showInactive(); applyOnTop(); }
}
function cycleMode() { update({ mode: MODES[(MODES.indexOf(settings.mode) + 1) % MODES.length] }); }
function setOpacity(v) { update({ opacity: Math.min(1, Math.max(0.3, Math.round(v * 100) / 100)) }); }

/* ---------- tray ---------- */
function refreshTray() {
  if (!tray) return;
  const worst = lastSnap ? Math.max(0, ...lastSnap.providers.flatMap(p => (p.gauges || []).map(g => g.pct))) : 0;
  tray.setImage(ringIcon(32, Math.min(1, worst / 100) || 0.0001));
  const t = lastSnap ? lastSnap.totals.today : null;
  tray.setToolTip(t ? `Usage Overlay — today ${Math.round(t.tokens / 1000).toLocaleString()}k tokens, $${t.cost.toFixed(2)}` : 'Usage Overlay');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Usage Overlay ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: win && win.isVisible() ? 'Hide overlay' : 'Show overlay', accelerator: 'Ctrl+Alt+U', click: toggleVisible },
    { label: 'Click-through (lock)', type: 'checkbox', checked: settings.clickThrough, accelerator: 'Ctrl+Alt+L', click: () => update({ clickThrough: !settings.clickThrough }) },
    { label: 'Always on top', type: 'checkbox', checked: settings.alwaysOnTop, click: () => update({ alwaysOnTop: !settings.alwaysOnTop }) },
    { type: 'separator' },
    { label: 'Layout', submenu: MODES.map(m => ({ label: m[0].toUpperCase() + m.slice(1), type: 'radio', checked: settings.mode === m, click: () => update({ mode: m }) })) },
    { label: 'Opacity', submenu: [0.5, 0.65, 0.8, 0.9, 1].map(v => ({ label: Math.round(v * 100) + '%', type: 'radio', checked: Math.abs(settings.opacity - v) < 0.05, click: () => setOpacity(v) })) },
    { label: 'Size', submenu: [0.8, 0.9, 1, 1.15, 1.3].map(v => ({ label: Math.round(v * 100) + '%', type: 'radio', checked: Math.abs(settings.scale - v) < 0.02, click: () => update({ scale: v }) })) },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings(loginArgs()).openAtLogin, click: m => update({ startWithWindows: m.checked }) },
    { type: 'separator' },
    { label: 'Refresh now', accelerator: 'Ctrl+Alt+R', click: manualRefresh },
    { label: 'Open data folder', click: () => shell.openPath(INGEST_DIR) },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

/* ---------- worker ---------- */
function workerSettings() {
  const { providersEnabled, budgets, pricing, extraPaths, refreshSec, claudeLiveLimits, monthlyBudget, codexLive, grokLive, antigravityLive } = settings;
  return { providersEnabled, budgets, pricing, extraPaths, refreshSec, claudeLiveLimits, monthlyBudget, codexLive, grokLive, antigravityLive };
}
function syncWorker() { if (worker) worker.postMessage({ type: 'settings', settings: workerSettings() }); }

function startWorker() {
  worker = new Worker(path.join(__dirname, 'lib', 'worker.js'), {
    workerData: { cacheFile: path.join(app.getPath('userData'), 'event-cache.json'), settings: workerSettings() },
    execArgv: ['--no-warnings'],
  });
  worker.on('message', m => {
    if (m.type === 'snapshot') {
      lastSnap = m.snap; status = 'ok';
      if (process.env.UO_SHOT && !global.__shot) { global.__shot = true; debugShots(); }
      if (win && !win.isDestroyed()) win.webContents.send('snapshot', lastSnap);
      refreshTray();
    } else if (m.type === 'status') { status = m.text; if (win && !win.isDestroyed()) win.webContents.send('status', status); }
    else if (m.type === 'error') { status = 'Error: ' + m.error.split('\n')[0]; pushState(); }
  });
  worker.on('error', err => { status = 'Worker error: ' + err.message; pushState(); });
  worker.on('exit', () => { if (!quitting) setTimeout(startWorker, 3000); });
}

/* ---------- local ingest endpoint ---------- */
function startIngest() {
  fs.mkdirSync(INGEST_DIR, { recursive: true });
  const srv = http.createServer((req, res) => {
    const send = (c, b) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.headers.origin) return send(403, { error: 'browser requests are not allowed' });   // no CSRF from web pages
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host || '')) return send(403, { error: 'bad host' });   // no DNS rebinding
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (req.method !== 'POST' || (req.url !== '/ingest' && req.url !== '/limits')) return send(404, { error: 'POST /ingest or /limits' });
    const isLimits = req.url === '/limits';
    let body = '', size = 0;
    req.on('data', d => { size += d.length; if (size > 1e6) { send(413, { error: 'too large' }); req.destroy(); } else body += d; });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        if (isLimits) {
          if (!writePushedLimits(j)) return send(400, { error: 'need {provider, plan?, windows:[{label, percentUsed, resetsAt}]}' });
          worker && worker.postMessage({ type: 'refresh' });
          return send(200, { ok: true });
        }
        const arr = Array.isArray(j) ? j : [j];
        const lines = arr.filter(o => o && o.provider).map(o => JSON.stringify({ ts: new Date().toISOString(), ...o })).join('\n');
        if (!lines) return send(400, { error: 'need {provider, model, input, output, ...}' });
        fs.appendFileSync(path.join(INGEST_DIR, 'http.jsonl'), lines + '\n');
        worker && worker.postMessage({ type: 'refresh' });
        send(200, { ok: true, accepted: arr.length });
      } catch { send(400, { error: 'invalid JSON' }); }
    });
  });
  srv.on('error', () => {});     // port busy: the file drop folder still works
  srv.listen(INGEST_PORT, '127.0.0.1');
}

/* ---------- dev: UO_SHOT=dir captures each layout to PNG and exits ---------- */
async function debugShots() {
  const dir = process.env.UO_SHOT;
  fs.mkdirSync(dir, { recursive: true });
  const snap = async n => { await new Promise(r => setTimeout(r, 1200)); const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(dir, n + '.png'), img.toPNG()); };
  const js = c => win.webContents.executeJavaScript('try{' + c + '}catch(e){String(e)}').then(r => r && console.log('js:', r), () => {});
  // injection check: user-controlled strings must never become live elements
  const xss = n => js("'xss[" + n + "]: ' + document.querySelectorAll('#root img,#root iframe,#root [onerror],#root script').length + ' live elements; payload shown as text: ' + document.getElementById('root').innerText.includes('onerror')");
  console.log('runtime: electron ' + process.versions.electron + ', node ' + process.versions.node + ' | events ' + lastSnap.eventCount + ' | errors ' + JSON.stringify(lastSnap.errors) + ' | providers ' + lastSnap.providers.map(p => p.id + ':' + p.ranges.all.requests).join(' '));
  win.show();
  update({ mode: 'full' });
  await snap('full'); await xss('full');
  // manual refresh: click, confirm the spinner, then wait for it to finish (live polls re-run)
  const t0 = Date.now();
  await js("document.querySelector('[data-act=refresh]').click()");
  await new Promise(r => setTimeout(r, 300));
  await js("'refresh[start]: spinning=' + !!document.querySelector('.ib.spin')");
  await snap('refreshing');
  for (let i = 0; i < 60; i++) {
    const spinning = await win.webContents.executeJavaScript("!!document.querySelector('.ib.spin')");
    if (!spinning) break;
    await new Promise(r => setTimeout(r, 500));
  }
  await js("'refresh[done after " + "' + (Date.now() - " + t0 + ") + 'ms]: header=' + document.querySelector('.hdr .sub').textContent");
  js("document.querySelector('[data-t=heat]').click()"); await new Promise(r => setTimeout(r, 400)); js("document.getElementById('scr').scrollTop=99999"); await snap('full-heat');
  js("document.querySelector('[data-t=mix]').click()"); await new Promise(r => setTimeout(r, 400)); js("document.getElementById('scr').scrollTop=99999"); await snap('full-mix');
  js("document.getElementById('bSet').click()"); await snap('settings');
  update({ mode: 'compact' }); js("S.settingsOpen=false;render()"); await snap('compact'); await xss('compact');
  update({ mode: 'pill' }); await snap('pill'); await xss('pill');
  app.exit(0);
}

/* ---------- IPC ---------- */
ipcMain.handle('get-state', () => ({ settings, status, ingest: { port: INGEST_PORT, dir: INGEST_DIR }, snap: lastSnap }));
ipcMain.on('update', (e, patch) => {
  const wk = ['providersEnabled', 'budgets', 'pricing', 'extraPaths', 'refreshSec', 'claudeLiveLimits', 'monthlyBudget', 'codexLive', 'grokLive', 'antigravityLive'].some(k => k in patch);
  update(patch, { workerSync: wk });
});
ipcMain.on('hide', () => win && win.hide());
ipcMain.on('refresh', manualRefresh);
ipcMain.on('cycle-mode', cycleMode);
ipcMain.on('open-data', () => shell.openPath(INGEST_DIR));
ipcMain.on('copy', (e, t) => clipboard.writeText(String(t)));
ipcMain.on('quit', () => app.quit());
ipcMain.on('content-height', (e, h) => {
  if (!win || settings.mode === 'full') return;
  const nh = Math.max(40, Math.min(Math.ceil(h * settings.scale) + 2, 900));
  const b = win.getBounds();
  if (Math.abs(b.height - nh) > 1) { win.setResizable(true); win.setBounds({ ...b, height: nh }); win.setResizable(false); }
});

/* ---------- lifecycle ---------- */
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { win.showInactive(); applyOnTop(); } });
  app.whenReady().then(() => {
    loadSettings();
    tray = new Tray(ringIcon(32, 0.6));
    tray.on('click', toggleVisible);
    createWindow();
    startWorker();
    startIngest();
    refreshTray();
    const reg = (acc, fn) => { try { globalShortcut.register(acc, fn); } catch {} };
    reg('Control+Alt+U', toggleVisible);
    reg('Control+Alt+L', () => update({ clickThrough: !settings.clickThrough }));
    reg('Control+Alt+M', cycleMode);
    reg('Control+Alt+R', manualRefresh);
    reg('Control+Alt+Up', () => setOpacity(settings.opacity + 0.05));
    reg('Control+Alt+Down', () => setOpacity(settings.opacity - 0.05));
    reg('Control+Alt+=', () => update({ scale: Math.min(1.6, +(settings.scale + 0.05).toFixed(2)) }));
    reg('Control+Alt+-', () => update({ scale: Math.max(0.7, +(settings.scale - 0.05).toFixed(2)) }));
    setInterval(() => { if (win && win.isVisible() && settings.alwaysOnTop) win.moveTop(); }, 15000);
  });
  app.on('before-quit', () => { quitting = true; if (worker) worker.postMessage({ type: 'flush' }); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', e => e.preventDefault());
}

