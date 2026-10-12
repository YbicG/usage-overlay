'use strict';
// Opt-in: fetch real Claude plan utilisation (5-hour / weekly windows) using the OAuth token that
// Claude Code already stored locally. The token is only ever sent to api.anthropic.com.
const fs = require('fs');
const path = require('path');
const { HOME } = require('./util');

function readToken() {
  const dirs = [process.env.CLAUDE_CONFIG_DIR, path.join(HOME, '.claude')].filter(Boolean);
  for (const d of dirs) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, '.credentials.json'), 'utf8'));
      const o = j.claudeAiOauth || j;
      if (o && o.accessToken) return { token: o.accessToken, plan: o.subscriptionType || null };
    } catch {}
  }
  return null;
}

async function fetchClaudeLimits() {
  const cred = readToken();
  if (!cred) throw new Error('No Claude Code login found (~/.claude/.credentials.json)');
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: 'Bearer ' + cred.token, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'usage-overlay/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('Claude usage API HTTP ' + res.status);
  const j = await res.json();
  const conv = (w, min) => w && typeof w.utilization === 'number' ? { pct: w.utilization, windowMin: min, resetsAt: w.resets_at ? Date.parse(w.resets_at) : null } : null;
  return { source: 'claude-oauth', plan: cred.plan, asOf: Date.now(), primary: conv(j.five_hour, 300), secondary: conv(j.seven_day, 10080) };
}

module.exports = { fetchClaudeLimits };
