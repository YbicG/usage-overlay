'use strict';
const H = 3600e3, D = 24 * H;
const BLOCK_MS = 5 * H;

const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, requests: 0 });
function add(a, e) {
  a.input += e.input; a.output += e.output; a.cacheRead += e.cacheRead; a.cacheWrite += e.cacheWrite;
  a.reasoning += e.reasoning; a.cost += e.cost; a.requests++;
}
function finish(a) {
  a.fresh = a.input + a.output + a.cacheWrite;            // tokens that are not cache hits
  a.tokens = a.fresh + a.cacheRead;                       // everything that went over the wire
  const ctx = a.input + a.cacheRead + a.cacheWrite;
  a.cacheHit = ctx > 0 ? a.cacheRead / ctx : 0;
  return a;
}
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** events must be sorted ascending by ts and carry a numeric `cost`. */
function aggregate(events, meta, settings, now = Date.now()) {
  const today0 = startOfDay(now);
  const cut = { today: today0, h24: now - D, d7: now - 7 * D, d30: now - 30 * D, all: 0 };
  const hourStart = Math.floor(now / H) * H;
  const dayKeys = [];
  for (let i = 29; i >= 0; i--) dayKeys.push(startOfDay(now - i * D));
  const dayIdx = new Map(dayKeys.map((t, i) => [t, i]));

  const mkP = id => ({
    ranges: Object.fromEntries(Object.keys(cut).map(k => [k, blank()])),
    hourly: new Array(24).fill(0), hourlyCost: new Array(24).fill(0),
    daily: dayKeys.map(() => ({ tokens: 0, cost: 0 })),
    models: new Map(), projects: new Map(), sessions: new Set(),
    lastTs: 0, firstTs: 0, recent30: blank(), win5h: blank(), win7d: blank(), block: null, blockStart: 0, blockTokens: blank(),
  });
  const P = new Map(), T = Object.fromEntries(Object.keys(cut).map(k => [k, blank()]));
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const dailyAll = dayKeys.map(t => ({ t, byProvider: {} }));
  const models = new Map(), projects = new Map();
  const hourlyAll = new Array(24).fill(0), hourlyAllCost = new Array(24).fill(0);

  for (const e of events) {
    let p = P.get(e.provider); if (!p) P.set(e.provider, p = mkP(e.provider));
    const t = e.ts;
    if (!p.firstTs) p.firstTs = t;
    p.lastTs = t;
    for (const k in cut) if (t >= cut[k]) { add(p.ranges[k], e); add(T[k], e); }
    const tok = e.input + e.output + e.cacheWrite + e.cacheRead;
    if (t >= now - 24 * H) {
      const hb = Math.floor((hourStart - Math.floor(t / H) * H) / H);          // 0 = this hour
      if (hb >= 0 && hb < 24) {
        p.hourly[23 - hb] += tok; p.hourlyCost[23 - hb] += e.cost;
        hourlyAll[23 - hb] += tok; hourlyAllCost[23 - hb] += e.cost;
      }
    }
    if (t >= cut.d30) {
      const di = dayIdx.get(startOfDay(t));
      if (di != null) {
        p.daily[di].tokens += tok; p.daily[di].cost += e.cost;
        const bp = dailyAll[di].byProvider[e.provider] || (dailyAll[di].byProvider[e.provider] = { tokens: 0, cost: 0 });
        bp.tokens += tok; bp.cost += e.cost;
      }
      const mk = e.provider + '|' + e.model;
      let m = models.get(mk); if (!m) models.set(mk, m = { provider: e.provider, model: e.model, ...blank() });
      add(m, e);
      let pm = p.models.get(e.model); if (!pm) p.models.set(e.model, pm = blank()); add(pm, e);
      if (e.project) {
        const pk = e.project; let pr = projects.get(pk); if (!pr) projects.set(pk, pr = { project: pk, byProvider: {}, ...blank() });
        add(pr, e); pr.byProvider[e.provider] = (pr.byProvider[e.provider] || 0) + 1;
      }
    }
    if (t >= cut.d7) {
      const d = new Date(t);
      heat[(d.getDay() + 6) % 7][d.getHours()] += tok;
    }
    if (t >= now - 30 * 60e3) add(p.recent30, e);
    if (t >= now - BLOCK_MS) add(p.win5h, e);
    if (t >= now - 7 * D) add(p.win7d, e);
    // 5h session blocks (a block starts at the first message after the previous one expired)
    if (t >= now - 2 * BLOCK_MS) {
      if (!p.blockStart || t >= p.blockStart + BLOCK_MS) { p.blockStart = Math.floor(t / H) * H; p.blockTokens = blank(); }
      add(p.blockTokens, e);
    }
  }

  const budgets = settings.budgets || {};
  const providers = [];
  for (const [id, p] of P) {
    const info = meta.providers[id] || { name: id[0].toUpperCase() + id.slice(1), color: hashColor(id) };
    for (const k in p.ranges) finish(p.ranges[k]);
    finish(p.recent30); finish(p.win5h); finish(p.win7d); finish(p.blockTokens);
    const mins = 30;
    const burn = { tokensPerMin: p.recent30.tokens / mins, freshPerMin: p.recent30.fresh / mins, costPerHour: p.recent30.cost * 2 };
    const blockActive = p.blockStart && now < p.blockStart + BLOCK_MS;
    const b = budgets[id] || {};
    const gauges = [];
    const lim = meta.limits[id];
    gauges.push(...limitGauges(lim, now));
    if (!gauges.length) {
      if (b.fiveHourTokens) gauges.push({ key: 'p5', label: '5h', pct: 100 * p.win5h.fresh / b.fiveHourTokens, resetsAt: blockActive ? p.blockStart + BLOCK_MS : null, used: p.win5h.fresh, cap: b.fiveHourTokens });
      if (b.weeklyTokens) gauges.push({ key: 'p7', label: '7d', pct: 100 * p.win7d.fresh / b.weeklyTokens, used: p.win7d.fresh, cap: b.weeklyTokens });
    }
    if (b.dailyCost) gauges.push({ key: 'dc', label: 'Day $', pct: 100 * p.ranges.today.cost / b.dailyCost, used: p.ranges.today.cost, cap: b.dailyCost, money: true });
    if (b.monthlyCost) gauges.push({ key: 'mc', label: '30d $', pct: 100 * p.ranges.d30.cost / b.monthlyCost, used: p.ranges.d30.cost, cap: b.monthlyCost, money: true });
    providers.push({
      id, name: info.name, color: info.color, lastTs: p.lastTs, firstTs: p.firstTs,
      active: now - p.lastTs < 3 * 60e3, ranges: p.ranges, hourly: p.hourly, hourlyCost: p.hourlyCost, daily: p.daily,
      models: [...p.models].map(([model, v]) => ({ model, ...finish(v) })).sort((a, b) => b.tokens - a.tokens).slice(0, 6),
      burn, block: blockActive ? { start: p.blockStart, end: p.blockStart + BLOCK_MS, ...p.blockTokens } : null,
      gauges, planLabel: lim && lim.plan ? lim.plan : null, limitsAsOf: lim && lim.asOf, limitsSource: lim && lim.source,
      error: meta.errors[id] || null,
    });
  }
  // include detected providers that have no events yet, and anything that only reported limits (e.g. via POST /limits)
  const extra = Object.entries(meta.providers).filter(([id, info]) => info.detected && !info.hidden);
  for (const id of Object.keys(meta.limits)) if (!meta.providers[id]) extra.push([id, { name: id[0].toUpperCase() + id.slice(1), color: hashColor(id), detected: true }]);
  for (const [id, info] of extra) {
    if (!P.has(id)) {
      const lim = meta.limits[id];
      providers.push({ id, name: info.name, color: info.color, empty: true, lastTs: 0, gauges: limitGauges(lim, now), planLabel: lim && lim.plan || null, limitsAsOf: lim && lim.asOf, limitsSource: lim && lim.source, ranges: Object.fromEntries(Object.keys(cut).map(k => [k, finish(blank())])), hourly: new Array(24).fill(0), daily: dayKeys.map(() => ({ tokens: 0, cost: 0 })), models: [], burn: { tokensPerMin: 0, costPerHour: 0 }, error: meta.errors[id] || null });
    }
  }
  providers.sort((a, b) => b.ranges.d30.cost - a.ranges.d30.cost || b.ranges.d30.tokens - a.ranges.d30.tokens);
  for (const k in T) finish(T[k]);

  const recent = events.slice(-40).reverse().map(e => ({ ts: e.ts, provider: e.provider, model: e.model, tokens: e.input + e.output + e.cacheRead + e.cacheWrite, output: e.output, cost: e.cost, project: e.project }));

  // all-provider burn
  const burnAll = { tokensPerMin: 0, costPerHour: 0 };
  for (const p of providers) if (p.burn) { burnAll.tokensPerMin += p.burn.tokensPerMin; burnAll.costPerHour += p.burn.costPerHour; }
  const mb = settings.monthlyBudget || 0;
  const elapsedDays = Math.max(1, (now - startOfDay(new Date(now).setDate(1))) / D);
  const dom = new Date(new Date(now).getFullYear(), new Date(now).getMonth() + 1, 0).getDate();
  const monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  let monthCost = 0; for (const e of events) if (e.ts >= monthStart.getTime()) monthCost += e.cost;
  const forecast = { monthCost, projected: monthCost / elapsedDays * dom, budget: mb, daysInMonth: dom };

  return {
    now, totals: T, providers, burn: burnAll, heat, dailyAll, hourlyAll, hourlyAllCost, forecast,
    models: [...models.values()].map(finish).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens).slice(0, 14),
    projects: [...projects.values()].map(finish).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens).slice(0, 10),
    recent, eventCount: events.length,
  };
}

const PALETTE = ['#f59e0b', '#22d3ee', '#fb7185', '#a3e635', '#e879f9', '#2dd4bf', '#facc15', '#818cf8'];
function hashColor(id) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }

/** Plan-limit windows reported by a tool (live, logs or pushed) as gauges. A window whose reset time has passed is empty again. */
function limitGauges(lim, now) {
  if (!lim) return [];
  const ws = lim.windows || [lim.primary && { ...lim.primary, label: windowLabel(lim.primary.windowMin) }, lim.secondary && { ...lim.secondary, label: windowLabel(lim.secondary.windowMin) }].filter(Boolean);
  return ws.map((w, i) => ({ key: 'w' + i, label: w.label || windowLabel(w.windowMin), pct: w.resetsAt && w.resetsAt < now ? 0 : w.pct, resetsAt: w.resetsAt, windowMin: w.windowMin, real: true, asOf: lim.asOf, source: lim.source, group: w.group }));
}

function windowLabel(min) {
  if (!min) return 'limit';
  if (min % 10080 === 0) return min === 10080 ? 'Weekly' : (min / 10080) + 'w';
  if (min % 1440 === 0) return (min / 1440) + 'd';
  if (min % 60 === 0) return (min / 60) + 'h';
  return min + 'm';
}

module.exports = { aggregate };
