'use strict';
const fs = require('fs');
const path = require('path');
const { estimateCost } = require('./pricing');
const { aggregate } = require('./aggregate');
const { fetchClaudeLimits } = require('./claudeLive');
const { fetchCodexLimits } = require('./codexLive');
const { fetchGrokLimits } = require('./grokLive');
const { fetchAntigravityLimits } = require('./antigravityLive');
const { readPushedLimits } = require('./pushedLimits');

const COLLECTORS = ['claude', 'codex', 'grok', 'antigravity', 'opencode', 'gemini', 'ingest'].map(n => require('./collectors/' + n));
const CACHE_VERSION = 4;   // bump whenever parsed event shape/meaning changes

class Engine {
  constructor({ cacheFile, settings }) {
    this.cacheFile = cacheFile;
    this.settings = settings || {};
    this.ctx = { cache: {}, settings: this.settings, dirty: false };
    this.errors = {};
    this.timings = {};
    this.live = {};
    this.onLive = null;
    this.lastSave = 0;
    this.loadCache();
  }

  loadCache() {
    if (!this.cacheFile) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (j.v === CACHE_VERSION) this.ctx.cache = j.cache || {};
    } catch {}
  }

  saveCache(force) {
    if (!this.cacheFile || !this.ctx.dirty) return;
    if (!force && Date.now() - this.lastSave < 30e3) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const tmp = this.cacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, cache: this.ctx.cache }));
      fs.renameSync(tmp, this.cacheFile);
      this.ctx.dirty = false; this.lastSave = Date.now();
    } catch {}
  }

  setSettings(s) { this.settings = s; this.ctx.settings = s; }

  /** Start a background poll for one live source if it's due; returns its latest {val, err}. */
  pollLive(id, everyMs, enabled, fn) {
    const st = this.live[id] || (this.live[id] = { at: 0, val: null, err: null, busy: false });
    if (enabled && !st.busy && Date.now() - st.at > everyMs) {
      st.busy = true; st.at = Date.now();
      Promise.resolve().then(fn)
        .then(v => { st.val = v || null; st.err = null; }, e => { st.err = String((e && e.message) || e); })
        .finally(() => { st.busy = false; if (this.onLive) this.onLive(id); });
    }
    return st;
  }

  /** Collect from every enabled provider and return a snapshot. */
  async snapshot(onProgress) {
    const meta = { providers: {}, limits: {}, errors: this.errors };
    const setLimit = (id, lim) => { if (lim && (!meta.limits[id] || (lim.asOf || 0) >= (meta.limits[id].asOf || 0))) meta.limits[id] = lim; };
    const all = [];
    const enabled = this.settings.providersEnabled || {};
    for (const c of COLLECTORS) {
      let detected = false;
      try { detected = !!c.detect(this.settings); } catch {}
      meta.providers[c.id] = { name: c.name, color: c.color, detected, hidden: !!c.hidden };
      if (!detected || enabled[c.id] === false) continue;
      const t0 = Date.now();
      if (onProgress) onProgress(c.name);
      try {
        const r = c.collect(this.ctx);
        delete this.errors[c.id];
        for (const e of r.events) all.push(e);
        if (r.limits) setLimit(c.id, r.limits);
      } catch (err) {
        this.errors[c.id] = String(err && err.message || err);
      }
      this.timings[c.id] = Date.now() - t0;
      // let the event loop breathe between heavy providers so settings messages stay responsive
      await new Promise(r => setImmediate(r));
    }
    // Live plan limits. Each source is polled in the background on its own cadence so a slow CLI never delays a
    // refresh; when a poll lands, onLive() triggers an immediate re-snapshot.
    const s = this.settings, det = id => meta.providers[id] && meta.providers[id].detected && enabled[id] !== false;
    const live = [
      ['claude', 180e3, !!s.claudeLiveLimits, fetchClaudeLimits],
      ['codex', 60e3, s.codexLive !== false && det('codex'), () => fetchCodexLimits().then(r => {
        const rl = r.rateLimits || {};
        const w = x => x && { pct: x.usedPercent, windowMin: x.windowDurationMins, resetsAt: x.resetsAt ? x.resetsAt * 1000 : null };
        return { source: 'codex-live', plan: rl.planType, asOf: Date.now(), primary: w(rl.primary), secondary: w(rl.secondary) };
      })],
      ['grok', 180e3, s.grokLive !== false && det('grok'), fetchGrokLimits],          // weekly credits move slowly; spawning the agent isn't free
      ['antigravity', 45e3, s.antigravityLive !== false && det('antigravity'), fetchAntigravityLimits],
    ];
    for (const [id, every, on, fn] of live) {
      const st = this.pollLive(id, every, on, fn);
      if (on && st.val && st.val.asOf > Date.now() - 10 * 60e3) setLimit(id, st.val);
      if (on && st.err) this.errors[id + 'Limits'] = st.err; else delete this.errors[id + 'Limits'];
    }

    // Limits pushed by anything else (POST /limits or files in ~/.usage-overlay/limits)
    for (const [id, lim] of Object.entries(readPushedLimits())) setLimit(id, lim);

    const overrides = this.settings.pricing || {};
    for (const e of all) if (e.cost == null) e.cost = estimateCost(e, overrides);
    all.sort((a, b) => a.ts - b.ts);
    this.saveCache(false);
    const snap = aggregate(all, meta, this.settings);
    snap.timings = this.timings;
    snap.errors = this.errors;
    snap.detected = Object.entries(meta.providers).filter(([, v]) => v.detected && !v.hidden).map(([id]) => id);
    return snap;
  }
}

module.exports = { Engine, COLLECTORS };
