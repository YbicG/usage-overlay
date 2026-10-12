'use strict';
// Runs collectors off the UI thread so parsing hundreds of MB of logs never freezes the overlay.
const { parentPort, workerData } = require('worker_threads');
const { Engine } = require('./engine');

const engine = new Engine({ cacheFile: workerData.cacheFile, settings: workerData.settings });
engine.onLive = () => tick();   // a live limit poll finished: show it now rather than at the next interval
let intervalMs = Math.max(2, (workerData.settings.refreshSec || 5)) * 1000;
let busy = false, again = false, timer = null;

async function tick() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    const snap = await engine.snapshot(name => parentPort.postMessage({ type: 'status', text: 'Reading ' + name + '…' }));
    parentPort.postMessage({ type: 'snapshot', snap });
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: String(err && err.stack || err) });
  }
  busy = false;
  if (again) { again = false; setImmediate(tick); }
}

function schedule() { clearInterval(timer); timer = setInterval(tick, intervalMs); }

parentPort.on('message', m => {
  if (m.type === 'settings') {
    engine.setSettings(m.settings);
    intervalMs = Math.max(2, (m.settings.refreshSec || 5)) * 1000;
    schedule(); tick();
  } else if (m.type === 'refresh') { if (m.force) engine.forceLive(); tick(); }
  else if (m.type === 'flush') { engine.saveCache(true); parentPort.postMessage({ type: 'flushed' }); }
});

schedule();
tick();
