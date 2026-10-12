'use strict';
/* global overlay */
const $root = document.getElementById('root');
const $tip = document.getElementById('tip');

const S = { settings: null, snap: null, status: '', ingest: null, expanded: new Set(), settingsOpen: false };
const PERIODS = [['today', 'Today'], ['h24', '24h'], ['d7', '7d'], ['d30', '30d'], ['all', 'All']];
const PERIOD_NAME = { today: 'today', h24: 'last 24h', d7: 'last 7 days', d30: 'last 30 days', all: 'all time' };
const TABS = [['models', 'Models'], ['projects', 'Projects'], ['mix', 'Tokens'], ['heat', 'Hours'], ['feed', 'Log']];
// Muted identity colours: just enough to tell providers apart, never louder than the numbers.
const PCOL = { claude: '#c98a6b', codex: '#7fae98', grok: '#a9a9a9', antigravity: '#9894c7', opencode: '#7ea4c0', gemini: '#869fd0', cursor: '#b9a36f' };
const SHORT = { claude: 'CL', codex: 'CX', grok: 'GK', antigravity: 'AG', opencode: 'OC', gemini: 'GM' };
const MIXC = { input: '#9aa6b6', output: '#d0d0d0', cacheRead: '#5f6670', cacheWrite: '#7d7466' };
const WIN_MIN = { '5h': 300, Day: 1440, Week: 10080, Weekly: 10080, '7d': 10080, '30d': 43200, Month: 43200 };

/* ---------- formatting ---------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtTok(n) {
  n = Math.round(n || 0);
  if (n < 1e3) return String(n);
  if (n < 1e4) return (n / 1e3).toFixed(1) + 'k';
  if (n < 1e6) return Math.round(n / 1e3) + 'k';
  if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + 'M';
  return (n / 1e9).toFixed(2) + 'B';
}
function fmtUSD(n) {
  n = n || 0;
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 100) return '$' + n.toFixed(2);
  if (n < 10000) return '$' + Math.round(n).toLocaleString();
  return '$' + (n / 1000).toFixed(1) + 'k';
}
const fmtM = (r, m) => (m === 'cost' ? fmtUSD(r.cost) : fmtTok(r.tokens));
const valOf = (r, m) => (m === 'cost' ? r.cost : r.tokens);
function fmtDur(ms) {
  if (ms == null || !isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}
const fmtIn = t => (t == null ? '' : t <= Date.now() ? 'reset' : fmtDur(t - Date.now()));   // window rolled over since the last reading
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}
const clock = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const shortModel = m => String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/^models\//, '');
const pcol = p => PCOL[p.id || p] || (p.color || '#999');
const sw = c => `<span class="sw8" style="--pc:${c}"></span>`;
function parseNum(s) {
  s = String(s).trim().toLowerCase().replace(/[$,\s]/g, '');
  if (!s) return 0;
  const m = s.match(/^([\d.]+)([kmb]?)$/);
  return m ? parseFloat(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[2]]) : 0;
}

const ICON = {
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  layout: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="1"/><path d="M4 10h16"/></svg>',
  hide: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.5H15"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M14 6l-6 6 6 6"/></svg>',
};

/* ---------- limits: the main thing ---------- */
function windowMs(g) { const m = g.windowMin || WIN_MIN[g.label]; return m ? m * 60e3 : null; }
/** Where you'd be if you spread usage evenly over the window, and when you'd run out at the current rate. */
function pace(g) {
  const W = windowMs(g);
  if (!W || !g.resetsAt) return null;
  const remain = g.resetsAt - Date.now();
  if (remain <= 0 || remain > W * 1.02) return null;
  const elapsed = W - remain, used = Math.max(0, g.pct);
  let outIn = null;
  // Only warn when you're clearly ahead of even pace; an old burst early in a long window isn't a problem.
  if (used >= 5 && elapsed > 10 * 60e3 && used > (elapsed / W) * 100 + 10) {
    const t = (100 - used) / (used / elapsed);
    if (t < remain * 0.95) outIn = t;
  }
  return { frac: Math.min(1, elapsed / W), outIn, remain };
}
function sortGauges(gs) {
  return gs.slice().sort((x, y) => String(x.group || '').localeCompare(String(y.group || '')) || (windowMs(x) || 9e15) - (windowMs(y) || 9e15));
}
function sourceText(g) {
  const age = g.asOf ? Date.now() - g.asOf : 0;
  if (!g.real) return 'estimated from your own cap';
  const src = { 'codex-live': 'Codex', 'grok-live': 'Grok', 'antigravity-live': 'Antigravity', 'claude-app': 'Claude app', 'claude-oauth': 'Claude API', pushed: 'pushed', codex: 'Codex logs' }[g.source] || g.source;
  return `from ${src}, ${age < 90e3 ? 'just now' : fmtDur(age) + ' ago'}`;
}
function limitRow(g) {
  const used = Math.max(0, Math.min(100, g.pct)), left = Math.round(100 - used);
  const pc = pace(g);
  const cls = used >= 90 ? 'crit' : used >= 70 || (pc && pc.outIn) ? 'warn' : '';
  const stale = g.asOf && Date.now() - g.asOf > 15 * 60e3;
  const tip = `${g.group ? g.group + ' · ' : ''}${g.label} window\n${left}% left, ${Math.round(used)}% used` +
    (g.cap ? `\n${g.money ? fmtUSD(g.used) + ' of ' + fmtUSD(g.cap) : fmtTok(g.used) + ' of ' + fmtTok(g.cap)}` : '') +
    (g.resetsAt ? `\nResets in ${fmtIn(g.resetsAt)} (${new Date(g.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })})` : '') +
    (pc ? `\nEven pace would be ${Math.round(pc.frac * 100)}% used by now` : '') + `\n${sourceText(g)}`;
  const note = pc && pc.outIn ? `<div class="note">At this rate you run out in ${fmtDur(pc.outIn)}, ${fmtDur(pc.remain - pc.outIn)} before reset</div>` : '';
  return `<div class="lim ${cls} ${stale ? 'stale' : ''}" data-tip="${esc(tip)}"><span class="l">${esc(g.label)}</span>
    <span class="meter"><i style="width:${used}%"></i>${pc ? `<b style="left:${(pc.frac * 100).toFixed(1)}%"></b>` : ''}</span>
    <span class="v n">${left}%</span><span class="r n">${g.resetsAt ? fmtIn(g.resetsAt) : ''}</span></div>${note}`;
}
function provLimits(p, set, showSpend = true) {
  const r = p.ranges[set.period];
  let last = null;
  const rows = sortGauges(p.gauges).map(g => {
    const head = g.group && g.group !== last ? `<div class="grp">${esc(g.group)}</div>` : '';
    last = g.group;
    return head + limitRow(g);
  }).join('');
  return `<div class="prov" style="--pc:${pcol(p)}"><div class="ph">${sw(pcol(p))}<span class="pn">${esc(p.name)}</span>${p.planLabel ? `<span class="pp">${esc(p.planLabel)}</span>` : ''}${p.active ? '<span class="act">active</span>' : ''}
    ${showSpend ? `<span class="ps n" data-tip="${esc(p.name)} ${PERIOD_NAME[set.period]}: ${fmtUSD(r.cost)} · ${fmtTok(r.tokens)} tokens · ${r.requests} calls">${fmtM(r, set.metric)}</span>` : ''}</div>${rows}</div>`;
}
function limitsSection(provs, set, compact) {
  const withLimits = provs.filter(p => p.gauges.length);
  const others = compact ? provs.filter(p => !p.gauges.length && p.ranges[set.period].requests) : [];
  if (!withLimits.length && !others.length) return `<div class="empty">No plan limits found yet.</div>`;
  return `<div class="limhead"><span>window</span><span data-tip="The bar fills as you use the window. The thin tick marks where you'd be if you spread usage evenly until the reset.">used  ·  tick = even pace</span><span>left</span><span>resets</span></div>` +
    withLimits.map(p => provLimits(p, set)).join('') + others.map(p => provLimits(p, set)).join('');
}

/* ---------- full layout pieces ---------- */
function stripHTML(snap, set) {
  const T = snap.totals[set.period], fc = snap.forecast, b = set.monthlyBudget || 0;
  const d = snap.dailyAll, key = 'cost';
  const sum = (a, z) => d.slice(a, z).reduce((x, y) => x + Object.values(y.byProvider).reduce((s, p) => s + p[key], 0), 0);
  let delta = '';
  if (set.period === 'today') { const c = sum(29, 30), p = sum(28, 29); if (p) delta = `<span class="${c > p ? 'up' : 'down'}">${c > p ? '+' : '−'}${Math.abs(Math.round((c - p) / p * 100))}%</span> vs yesterday`; }
  else if (set.period === 'd7') { const c = sum(23, 30), p = sum(16, 23); if (p) delta = `<span class="${c > p ? 'up' : 'down'}">${c > p ? '+' : '−'}${Math.abs(Math.round((c - p) / p * 100))}%</span> vs prior week`; }
  return `<div class="strip">
    <div><div class="k">Spend, ${PERIOD_NAME[set.period]}</div><div class="v n">${fmtUSD(T.cost)}</div><div class="s">${delta || T.requests.toLocaleString() + ' calls'}</div></div>
    <div><div class="k">Tokens</div><div class="v n">${fmtTok(T.tokens)}</div><div class="s n">${Math.round(T.cacheHit * 100)}% cached</div></div>
    <div><div class="k">Last 30 min</div><div class="v n">${fmtTok(snap.burn.tokensPerMin)}<span style="font-size:11px;color:var(--mut)">/min</span></div><div class="s n">${fmtUSD(snap.burn.costPerHour)}/h</div></div>
    <div><div class="k">This month</div><div class="v n">${fmtUSD(fc.monthCost)}</div><div class="s n" data-tip="Straight-line projection from this month so far">→ ${fmtUSD(fc.projected)}${b ? ' of ' + fmtUSD(b) : ''}</div></div></div>`;
}
function chartHTML(snap, set) {
  const key = set.metric === 'cost' ? 'cost' : 'tokens', f = v => (key === 'cost' ? fmtUSD(v) : fmtTok(v));
  const days = snap.dailyAll, order = snap.providers.map(p => p.id);
  const totals = days.map(d => Object.values(d.byProvider).reduce((s, p) => s + p[key], 0));
  const max = Math.max(...totals, 1e-9), W = 460, H = 78, bw = W / days.length;
  let g = `<line x1="0" y1="${H + 0.5}" x2="${W}" y2="${H + 0.5}" stroke="rgba(255,255,255,.12)"/>`;
  days.forEach((d, i) => {
    let y = H;
    for (const id of order) {
      const v = (d.byProvider[id] || {})[key] || 0;
      if (!v) continue;
      const h = Math.max(1, v / max * (H - 2));
      y -= h;
      g += `<rect x="${(i * bw + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${PCOL[id] || '#999'}" opacity="${i === days.length - 1 ? 1 : 0.75}"/>`;
    }
    g += `<rect data-i="${i}" x="${i * bw}" y="0" width="${bw}" height="${H}" fill="transparent"/>`;
  });
  const lbl = t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const legend = snap.providers.filter(p => p.ranges.d30.requests).map(p => `<span>${sw(pcol(p))}${esc(p.name)}</span>`).join('');
  return `<div class="sec chart"><div class="sech"><b>Last 30 days</b><span class="n">${key === 'cost' ? 'est. cost' : 'tokens'} · peak ${f(max)}</span></div>
    <svg id="dchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${g}</svg>
    <div class="axis"><span>${lbl(days[0].t)}</span><span>${lbl(days[15].t)}</span><span>today</span></div><div class="legend">${legend}</div></div>`;
}
function spark(vals) {
  const w = 70, h = 16, max = Math.max(...vals, 1), n = vals.length;
  if (!vals.some(Boolean)) return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><line x1="0" y1="${h - 0.5}" x2="${w}" y2="${h - 0.5}" stroke="rgba(255,255,255,.1)"/></svg>`;
  const pts = vals.map((v, i) => `${(i * w / (n - 1)).toFixed(1)},${(h - 1 - v / max * (h - 2)).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline points="${pts}" fill="none" stroke="#9a9a9a" stroke-width="1"/></svg>`;
}
function providerTable(provs, set) {
  const rows = provs.map(p => {
    const r = p.ranges[set.period], open = S.expanded.has(p.id);
    let det = '';
    if (open) {
      det = `<tr class="det"><td colspan="5"><div class="det-grid">` +
        (p.models.length ? p.models.map(x => `<span class="x">${esc(shortModel(x.model))}</span><span class="n">${fmtTok(x.tokens)}</span><span class="n x">${fmtUSD(x.cost)}</span>`).join('') : '<span>No models in the last 30 days</span><span></span><span></span>') +
        `<span>input · output · cache read · cache write</span><span></span><span class="n">${fmtTok(r.input)} · ${fmtTok(r.output)} · ${fmtTok(r.cacheRead)} · ${fmtTok(r.cacheWrite)}</span>` +
        `<span>last activity</span><span></span><span class="n">${p.lastTs ? ago(p.lastTs) : 'never'}</span></div>${p.error ? `<div class="perr">${esc(p.error)}</div>` : ''}</td></tr>`;
    }
    return `<tr class="row ${r.requests ? '' : 'idle'}" data-id="${esc(p.id)}"><td><span class="nm">${sw(pcol(p))}${esc(p.name)}</span></td>
      <td class="n">${r.requests ? r.requests.toLocaleString() : '–'}</td><td class="n">${r.tokens ? fmtTok(r.tokens) : '–'}</td><td class="n">${r.cost ? fmtUSD(r.cost) : '–'}</td>
      <td class="spk" data-tip="Tokens per hour, last 24h">${spark(p.hourly)}</td></tr>${det}`;
  }).join('');
  return `<div class="sec"><div class="sech"><b>Providers</b><span>${PERIOD_NAME[set.period]}</span></div>
    <table class="tbl"><tr><th>name</th><th>calls</th><th>tokens</th><th>cost</th><th>24h</th></tr>${rows}</table></div>`;
}
function listRows(rows, m, nameFn, subFn, colFn) {
  if (!rows.length) return '<div class="empty">Nothing yet.</div>';
  const max = Math.max(...rows.map(r => valOf(r, m)), 1e-9);
  return `<div class="list">${rows.map(r => `<div class="li"><div class="a">${sw(colFn(r))}<span class="t">${nameFn(r)}</span></div><span class="b n">${subFn(r)}</span><span class="c n">${fmtM(r, m)}</span>
    <div class="share"><i style="width:${(valOf(r, m) / max * 100).toFixed(1)}%"></i></div></div>`).join('')}</div>`;
}
function tabHTML(snap, set) {
  const m = set.metric, byId = Object.fromEntries(snap.providers.map(p => [p.id, p]));
  switch (set.tab) {
    case 'models':
      return listRows(snap.models, m, r => esc(shortModel(r.model)), r => `${r.requests.toLocaleString()} calls`, r => pcol(r.provider));
    case 'projects':
      return listRows(snap.projects, m, r => esc(r.project), r => `${r.requests.toLocaleString()} calls`, r => pcol(Object.entries(r.byProvider).sort((a, b) => b[1] - a[1])[0][0]));
    case 'mix': {
      const T = snap.totals[set.period];
      const parts = [['input', 'Input', T.input], ['output', 'Output', T.output], ['cacheRead', 'Cache read', T.cacheRead], ['cacheWrite', 'Cache write', T.cacheWrite]];
      const tot = parts.reduce((a, p) => a + p[2], 0) || 1;
      return `<div class="stack">${parts.map(([k, n, v]) => `<i style="width:${v / tot * 100}%;background:${MIXC[k]}" data-tip="${n}: ${fmtTok(v)}"></i>`).join('')}</div>
        <div class="list">${parts.map(([k, n, v]) => `<div class="li"><div class="a">${sw(MIXC[k])}<span class="t">${n}</span></div><span class="b n">${(v / tot * 100).toFixed(1)}%</span><span class="c n">${fmtTok(v)}</span></div>`).join('')}
        <div class="li"><div class="a"><span class="t" style="color:var(--mut)">of which reasoning</span></div><span class="b"></span><span class="c n">${fmtTok(T.reasoning)}</span></div></div>
        <div class="sech" style="margin-top:12px"><b>Cache hit rate</b><span>${PERIOD_NAME[set.period]}</span></div>
        <div class="list">${snap.providers.filter(p => p.ranges[set.period].tokens).map(p => `<div class="li"><div class="a">${sw(pcol(p))}<span class="t">${esc(p.name)}</span></div><span class="b"></span><span class="c n">${Math.round(p.ranges[set.period].cacheHit * 100)}%</span></div>`).join('') || '<div class="empty">No usage in this period.</div>'}</div>`;
    }
    case 'heat': {
      const max = Math.max(...snap.heat.flat(), 1), days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      let g = '<div></div>' + Array.from({ length: 24 }, (_, h) => `<div class="hh">${h % 6 === 0 ? String(h).padStart(2, '0') : ''}</div>`).join('');
      snap.heat.forEach((row, d) => { g += `<div class="hl">${days[d]}</div>` + row.map((v, h) => `<div class="c" style="--i:${Math.sqrt(v / max).toFixed(3)}" data-tip="${days[d]} ${String(h).padStart(2, '0')}:00 — ${fmtTok(v)} tokens"></div>`).join(''); });
      const hm = Math.max(...snap.hourlyAll, 1), nowH = new Date().getHours();
      return `<div class="sech"><span>Tokens by hour, last 7 days</span></div><div class="heat">${g}</div>
        <div class="sech" style="margin:14px 0 0"><span>Last 24 hours</span></div>
        <div class="hours">${snap.hourlyAll.map((v, i) => `<i style="height:${Math.max(1, v / hm * 100)}%" data-tip="${String((nowH - 23 + i + 48) % 24).padStart(2, '0')}:00 — ${fmtTok(v)} tokens, ${fmtUSD(snap.hourlyAllCost[i])}"></i>`).join('')}</div>`;
    }
    default:
      return `<div class="feed">${snap.recent.slice(0, 30).map(e => `<div class="fi"><span class="tm n">${clock(e.ts)}</span><span class="md">${sw(pcol(e.provider))}${esc(shortModel(e.model))}<small>${esc(e.project || '')}</small></span><span class="vv n">${fmtTok(e.tokens)}  ${fmtUSD(e.cost)}</span></div>`).join('') || '<div class="empty">No activity yet.</div>'}</div>`;
  }
}

/* ---------- chrome ---------- */
function headerHTML(set, snap, opts = {}) {
  const upd = !snap ? '' : S.doneAt && Date.now() - S.doneAt < 4000 ? 'updated just now' : new Date(snap.now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `<div class="hdr"><span class="title">${opts.title || 'Usage'}</span>${opts.title ? '' : `<span class="sub n">${upd}</span>`}${set.clickThrough ? '<span class="lockflag" data-tip="Mouse passes through. Ctrl+Alt+L to unlock">locked</span>' : ''}<span class="spacer"></span>
    <div class="btns">
      ${opts.title ? '' : refreshBtn()}
      ${opts.title ? '' : `<button class="ib" id="bMetric" data-tip="Sort and show by ${set.metric === 'cost' ? 'tokens' : 'cost'}"><span class="txt">${set.metric === 'cost' ? '$' : 'tok'}</span></button>`}
      <button class="ib" id="bMode" data-tip="Layout: ${set.mode} (Ctrl+Alt+M)">${ICON.layout}</button>
      <button class="ib ${S.settingsOpen ? 'on' : ''}" id="bSet" data-tip="${S.settingsOpen ? 'Back' : 'Settings'}">${S.settingsOpen ? ICON.back : ICON.gear}</button>
      <button class="ib" id="bHide" data-tip="Hide (Ctrl+Alt+U)">${ICON.hide}</button>
    </div></div>`;
}
function refreshBtn() {
  return `<button class="ib ${S.refreshing ? 'spin' : ''}" data-act="refresh" data-tip="${S.refreshing ? 'Refreshing logs and live limits…' : 'Refresh now (Ctrl+Alt+R)'}">${ICON.refresh}</button>`;
}
function periodBar(snap, set) {
  const T = snap.totals[set.period];
  return `<div class="bar2"><div class="periods" id="periodSeg">${PERIODS.map(([k, n]) => `<button data-p="${k}" class="${set.period === k ? 'on' : ''}">${n}</button>`).join('')}</div><span class="spacer"></span>
    <span class="totals n"><span>${fmtUSD(T.cost)}</span><span class="m">${fmtTok(T.tokens)}</span></span></div>`;
}
function footerHTML(snap) {
  const errs = Object.keys(snap.errors || {});
  return `<div class="ftr"><span class="n">${snap.eventCount.toLocaleString()} events</span>
    ${errs.length ? `<span class="err" data-tip="${esc(Object.entries(snap.errors).map(([k, v]) => k + ': ' + v).join('\n'))}">${errs.length} source${errs.length > 1 ? 's' : ''} failing</span>` : ''}
    <button data-act="refresh">${S.refreshing ? 'Refreshing…' : 'Refresh'}</button></div>`;
}

/* ---------- settings ---------- */
function settingsHTML(set, snap) {
  const detected = snap ? snap.detected : [];
  const names = snap ? Object.fromEntries(snap.providers.map(p => [p.id, p])) : {};
  const tg = (id, on) => `<button class="tg ${on ? 'on' : ''}" data-sw="${id}" aria-pressed="${!!on}"></button>`;
  const bv = (id, k, money) => { const v = (set.budgets[id] || {})[k]; return v ? (money ? v : fmtTok(v)) : ''; };
  const curl = `curl -X POST http://127.0.0.1:${S.ingest ? S.ingest.port : 47615}/ingest -H "Content-Type: application/json" -d '{"provider":"cursor","model":"gpt-5","input":1200,"output":300,"cost":0.02}'`;
  const nm = id => `<span class="nm">${sw(pcol(id))}${esc((names[id] || { name: id }).name)}</span>`;
  return `<div class="settings">
    <div class="sec"><div class="sech"><b>Display</b></div>
      <div class="row"><span>Layout</span><div class="choice" id="modeSeg">${['full', 'compact', 'pill'].map(k => `<button data-mode="${k}" class="${set.mode === k ? 'on' : ''}">${k}</button>`).join('')}</div></div>
      <div class="row"><span>Background</span><input type="range" min="30" max="100" value="${Math.round(set.opacity * 100)}" id="sOpacity"></div>
      <div class="row"><span>Size</span><input type="range" min="70" max="160" value="${Math.round(set.scale * 100)}" id="sScale"></div>
    </div>
    <div class="sec"><div class="sech"><b>Window</b></div>
      <div class="row"><div><div>Always on top</div><div class="d">Stays above fullscreen apps and games</div></div>${tg('alwaysOnTop', set.alwaysOnTop)}</div>
      <div class="row"><div><div>Click-through</div><div class="d">Mouse passes through; <span class="kbd">Ctrl+Alt+L</span> toggles</div></div>${tg('clickThrough', set.clickThrough)}</div>
      <div class="row"><div>Start with Windows</div>${tg('startWithWindows', set.startWithWindows)}</div>
      <div class="row"><div>Refresh interval</div><span><input type="number" min="2" max="120" value="${set.refreshSec}" id="sRefresh" style="width:52px"> <span class="d">s</span></span></div>
    </div>
    <div class="sec"><div class="sech"><b>Sources</b></div>
      ${detected.map(id => `<div class="row">${nm(id)}${tg('prov:' + id, set.providersEnabled[id] !== false)}</div>`).join('') || '<div class="empty">No tools detected yet.</div>'}
      <div class="row"><div><div>Claude via API</div><div class="d">Alternative to the scheduled task; needs <span class="kbd">claude auth login</span></div></div>${tg('claudeLiveLimits', set.claudeLiveLimits)}</div>
    </div>
    <div class="sec"><div class="sech"><b>Your own caps</b><span>for tools without real limits</span></div>
      <div class="row"><span>Monthly budget, all tools</span><input type="text" id="sMonthly" value="${set.monthlyBudget || ''}" placeholder="$"></div>
      <div class="bgrid" style="margin-top:6px"><span></span><span class="hd">5h tok</span><span class="hd">7d tok</span><span class="hd">day $</span><span class="hd">30d $</span>
      ${detected.map(id => `${nm(id)}<input type="text" data-b="${id}:fiveHourTokens" value="${bv(id, 'fiveHourTokens')}"><input type="text" data-b="${id}:weeklyTokens" value="${bv(id, 'weeklyTokens')}"><input type="text" data-b="${id}:dailyCost" value="${bv(id, 'dailyCost', 1)}"><input type="text" data-b="${id}:monthlyCost" value="${bv(id, 'monthlyCost', 1)}">`).join('')}</div>
    </div>
    <div class="sec"><div class="sech"><b>Other tools</b></div>
      <div class="d" style="margin-bottom:6px">Anything that can make an HTTP request can report usage. Lines can also be appended to <span class="kbd">${esc(S.ingest ? S.ingest.dir : '')}</span></div>
      <div class="code">${esc(curl)}</div>
      <div style="display:flex;gap:6px;margin-top:6px"><button class="btn" id="bCopy">Copy</button><button class="btn" id="bFolder">Open folder</button></div>
    </div>
    <div class="sec"><div class="sech"><b>Keys</b></div>
      <div class="keys"><span class="kbd">Ctrl+Alt+U</span><span>show / hide</span><span class="kbd">Ctrl+Alt+L</span><span>click-through</span><span class="kbd">Ctrl+Alt+M</span><span>layout</span><span class="kbd">Ctrl+Alt+↑ ↓</span><span>background</span><span class="kbd">Ctrl+Alt+= −</span><span>size</span></div>
      <div class="d" style="margin-top:10px">Costs are list-price estimates unless the tool reports its own. On subscriptions they show what the same usage would cost on the API.</div>
    </div></div>`;
}

/* ---------- render ---------- */
function render() {
  const set = S.settings, snap = S.snap;
  if (!set) return;
  document.documentElement.style.setProperty('--alpha', Math.max(0.3, set.opacity));
  const keep = ($root.querySelector('.scroll') || {}).scrollTop || 0;
  $root.className = `panel mode-${set.mode}`;
  if (!snap) {
    $root.innerHTML = `<div class="boot"><div id="bootText">${esc(S.status || 'Reading usage logs…')}</div><div class="hint">The first run reads your full history. After that it starts instantly.</div></div>`;
    return;
  }
  const m = set.metric;
  const provs = [...snap.providers].sort((a, b) => valOf(b.ranges[set.period], m) - valOf(a.ranges[set.period], m) || b.gauges.length - a.gauges.length);
  const T = snap.totals[set.period];

  if (set.mode === 'pill') {
    // Tightest limit per provider, e.g. "CL 94  AG 82"
    const segs = provs.filter(p => p.gauges.length).map(p => {
      const g = p.gauges.slice().sort((a, b) => b.pct - a.pct)[0], used = g.pct;
      return `<span class="seg ${used >= 90 ? 'crit' : used >= 70 ? 'warn' : ''}" data-tip="${esc(p.name)}: tightest is ${esc((g.group ? g.group + ' ' : '') + g.label)}, ${Math.round(100 - used)}% left${g.resetsAt ? ', resets in ' + fmtIn(g.resetsAt) : ''}">${SHORT[p.id] || esc(p.name.slice(0, 2).toUpperCase())} <b class="n">${Math.round(100 - used)}</b></span>`;
    }).join('');
    $root.innerHTML = `<div class="pill"><span class="tot n" data-tip="${PERIOD_NAME[set.period]}">${fmtM(T, m)}</span>${segs}<span class="spacer"></span>${refreshBtn()}<button class="ib" id="bMode" data-tip="Layout (Ctrl+Alt+M)">${ICON.layout}</button></div>`;
  } else if (S.settingsOpen) {
    $root.innerHTML = `${headerHTML(set, snap, { title: 'Settings' })}<div class="scroll">${settingsHTML(set, snap)}</div>`;
  } else if (set.mode === 'compact') {
    $root.innerHTML = `${headerHTML(set, snap)}${periodBar(snap, set)}<div class="scroll" style="overflow:visible"><div class="sec">${limitsSection(provs, set, true)}</div></div>`;
  } else {
    $root.innerHTML = `${headerHTML(set, snap)}${periodBar(snap, set)}<div class="scroll" id="scr">
      ${stripHTML(snap, set)}
      <div class="sec"><div class="sech"><b>Plan limits</b><span>percent left in each window</span></div>${limitsSection(provs, set, false)}</div>
      ${chartHTML(snap, set)}
      ${providerTable(provs, set)}
      <div class="sec"><div class="tabs" id="tabs">${TABS.map(([k, n]) => `<button data-t="${k}" class="${set.tab === k ? 'on' : ''}">${n}</button>`).join('')}</div>${tabHTML(snap, set)}</div>
    </div>${footerHTML(snap)}`;
  }
  const sc = $root.querySelector('.scroll'); if (sc && !S.jump) sc.scrollTop = keep;
  S.jump = false;
  bind();
  if (set.mode !== 'full' && !S.settingsOpen) requestAnimationFrame(() => overlay.contentHeight(Math.ceil($root.scrollHeight) + 2));
}

/* ---------- events ---------- */
function bind() {
  const $ = id => document.getElementById(id);
  const on = (id, fn) => { const e = $(id); if (e) e.onclick = fn; };
  on('bMetric', () => overlay.update({ metric: S.settings.metric === 'cost' ? 'tokens' : 'cost' }));
  on('bMode', () => overlay.cycleMode());
  on('bHide', () => overlay.hide());
  document.querySelectorAll('[data-act=refresh]').forEach(el => el.onclick = startRefresh);
  on('bSet', () => {
    S.settingsOpen = !S.settingsOpen; S.jump = true;
    if (S.settingsOpen && S.settings.mode !== 'full') { S.returnMode = S.settings.mode; overlay.update({ mode: 'full' }); }
    else if (!S.settingsOpen && S.returnMode) { const r = S.returnMode; S.returnMode = null; overlay.update({ mode: r }); }
    else render();
  });
  on('bCopy', () => overlay.copy(document.querySelector('.settings .code').textContent));
  on('bFolder', () => overlay.openData());
  const ps = $('periodSeg'); if (ps) ps.onclick = e => { const p = e.target.dataset.p; if (p) overlay.update({ period: p }); };
  const tb = $('tabs'); if (tb) tb.onclick = e => { const t = e.target.dataset.t; if (t) overlay.update({ tab: t }); };
  document.querySelectorAll('tr.row').forEach(el => el.onclick = () => { const id = el.dataset.id; S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id); render(); });
  const ms = $('modeSeg'); if (ms) ms.onclick = e => { const k = e.target.dataset.mode; if (k) { S.returnMode = null; S.settingsOpen = k === 'full'; overlay.update({ mode: k }); } };
  document.querySelectorAll('[data-sw]').forEach(el => el.onclick = () => {
    const id = el.dataset.sw, s = S.settings;
    if (id.startsWith('prov:')) { const pid = id.slice(5); overlay.update({ providersEnabled: { ...s.providersEnabled, [pid]: s.providersEnabled[pid] === false } }); }
    else overlay.update({ [id]: !s[id] });
  });
  const rg = (id, key, f) => { const e = $(id); if (!e) return; e.oninput = () => { S.settings[key] = f(e.value); document.documentElement.style.setProperty('--alpha', S.settings.opacity); }; e.onchange = () => overlay.update({ [key]: f(e.value) }); };
  rg('sOpacity', 'opacity', v => v / 100); rg('sScale', 'scale', v => v / 100);
  const rf = $('sRefresh'); if (rf) rf.onchange = () => overlay.update({ refreshSec: Math.max(2, Math.min(120, +rf.value || 5)) });
  const mo = $('sMonthly'); if (mo) mo.onchange = () => overlay.update({ monthlyBudget: parseNum(mo.value) });
  document.querySelectorAll('[data-b]').forEach(el => el.onchange = () => {
    const [id, k] = el.dataset.b.split(':'), b = JSON.parse(JSON.stringify(S.settings.budgets || {}));
    b[id] = b[id] || {}; const v = parseNum(el.value); if (v) b[id][k] = v; else delete b[id][k];
    overlay.update({ budgets: b });
  });
  const dc = $('dchart');
  if (dc) {
    dc.onmousemove = e => {
      const t = e.target; if (!t.dataset || t.dataset.i == null) return hideTip();
      const d = S.snap.dailyAll[+t.dataset.i], key = S.settings.metric === 'cost' ? 'cost' : 'tokens';
      const rows = S.snap.providers.filter(p => d.byProvider[p.id] && d.byProvider[p.id][key]);
      const f = v => (key === 'cost' ? fmtUSD(v) : fmtTok(v));
      const tot = rows.reduce((s, p) => s + d.byProvider[p.id][key], 0);
      showTip(e, `<div class="tr"><b>${new Date(d.t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</b><span>${f(tot)}</span></div>` +
        rows.map(p => `<div class="tr"><span>${esc(p.name)}</span><span>${f(d.byProvider[p.id][key])}</span></div>`).join(''));
    };
    dc.onmouseleave = hideTip;
  }
}

function showTip(e, html) {
  $tip.innerHTML = html; $tip.hidden = false;
  const r = $tip.getBoundingClientRect();
  let x = e.clientX + 12, y = e.clientY + 14;
  if (x + r.width > innerWidth - 4) x = e.clientX - r.width - 10;
  if (y + r.height > innerHeight - 4) y = e.clientY - r.height - 10;
  $tip.style.left = Math.max(4, x) + 'px'; $tip.style.top = Math.max(4, y) + 'px';
}
function hideTip() { $tip.hidden = true; }
const tipHTML = t => esc(t).replace(/\n/g, '<br>');
document.addEventListener('mouseover', e => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t) showTip(e, tipHTML(t.dataset.tip)); else if (!e.target.closest('#dchart')) hideTip(); });
document.addEventListener('mousemove', e => { const t = e.target.closest && e.target.closest('[data-tip]'); if (!$tip.hidden && t) showTip(e, tipHTML(t.dataset.tip)); });
document.addEventListener('mouseleave', hideTip);

/* ---------- manual refresh ---------- */
// Spins until a snapshot arrives with every live limit poll finished (or 30 s pass), then shows "updated just now".
function startRefresh() {
  if (!S.refreshing) overlay.refresh();
  markRefreshing();
}
function markRefreshing() {
  S.refreshing = Date.now();
  clearTimeout(S.refreshTimer);
  S.refreshTimer = setTimeout(() => finishRefresh(), 30000);
  render();
}
function finishRefresh() {
  if (!S.refreshing) return;
  S.refreshing = 0; S.doneAt = Date.now();
  clearTimeout(S.refreshTimer);
  setTimeout(() => { if (!S.settingsOpen) render(); }, 4100);   // drop the "just now" label
}

/* ---------- wiring ---------- */
overlay.on('refreshing', markRefreshing);    // started from the tray or Ctrl+Alt+R
overlay.on('snapshot', snap => {
  S.snap = snap;
  if (S.refreshing && !snap.liveBusy && Date.now() - S.refreshing > 600) finishRefresh();
  if (S.settingsOpen && document.activeElement && document.activeElement.tagName === 'INPUT') return;   // don't steal focus while typing
  render();
});
overlay.on('state', st => {
  const modeChanged = S.settings && S.settings.mode !== st.settings.mode;
  S.settings = st.settings; S.status = st.status; S.ingest = st.ingest;
  if (modeChanged && st.settings.mode !== 'full' && !S.returnMode) S.settingsOpen = false;
  render();
});
overlay.on('status', t => { S.status = t; const b = document.getElementById('bootText'); if (b) b.textContent = t; });
overlay.getState().then(st => { S.settings = st.settings; S.snap = st.snap; S.status = st.status; S.ingest = st.ingest; render(); });
setInterval(() => { if (S.snap && !S.settingsOpen && !document.querySelector('input:focus')) render(); }, 30000);   // keep countdowns current
window.addEventListener('keydown', e => { if (e.key === 'Escape' && S.settingsOpen) document.getElementById('bSet').click(); });
