'use strict';
const fs = require('fs');
const path = require('path');
const { HOME, walk, baseName, readJsonSafe } = require('../util');
const { mk, parseFiles } = require('./common');

const dirOf = () => path.join(process.env.GROK_HOME || path.join(HOME, '.grok'), 'sessions');

function parse(file) {
  const j = readJsonSafe(file, null);
  if (!j || !Array.isArray(j.turns)) return { events: [] };
  let project = '';
  try { project = baseName(decodeURIComponent(path.basename(path.dirname(path.dirname(file))))); } catch {}
  const events = [];
  for (const t of j.turns) {
    const ts = Date.parse(t.endedAt);
    if (!ts) continue;
    const mu = t.modelUsage && Object.keys(t.modelUsage).length ? t.modelUsage : { [t.primaryModelId || 'grok']: t };
    for (const [model, u] of Object.entries(mu)) {
      const cached = u.cachedReadTokens || 0;
      events.push(mk({
        ts, provider: 'grok', model,
        input: Math.max(0, (u.inputTokens || 0) - cached), cacheRead: cached, cacheWrite: u.cacheCreationTokens,
        output: u.outputTokens, reasoning: u.reasoningTokens,
        cost: u.costUsdTicks ? u.costUsdTicks / 1e10 : null,   // 1e10 ticks = 1 USD
        project, session: j.sessionId,
      }));
    }
  }
  return { events };
}

module.exports = {
  id: 'grok', name: 'Grok', color: '#c7ced9',
  detect: () => fs.existsSync(dirOf()),
  collect(ctx) {
    const files = walk(dirOf(), (p, n) => n === 'usage.json');
    for (const d of (ctx.settings.extraPaths && ctx.settings.extraPaths.grok) || []) walk(d, (p, n) => n === 'usage.json', files);
    return { events: parseFiles(ctx, 'grok', files, parse).events };
  },
};
