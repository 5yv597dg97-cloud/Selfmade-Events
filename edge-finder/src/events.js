// Getting odds and scores, from The Odds API or from local files for testing.
import { readFileSync } from 'node:fs';
import { fetchEvents, fetchOdds, fetchScores, fetchSports } from './odds-api.js';
import { grade, doubleOutcome } from './settle.js';

// The sharp books we need in every request when naming bookmakers explicitly.
const SHARP_REQUEST = ['pinnacle', 'betfair_ex_uk'];

/**
 * Turns "tennis_*" into every tennis competition currently open and drops
 * sports that are out of season, keeping your priority order. The sports list
 * is free, and its response also says how many credits are left.
 */
export async function expandSports(cfg, sports, fetchImpl = fetch) {
  const { data, remaining } = await fetchSports({ apiKey: cfg.apiKey, fetchImpl });
  const active = data.filter((s) => s.active && !s.has_outrights).map((s) => s.key);
  const keys = sports.flatMap((s) => (s.endsWith('*') ? active.filter((k) => k.startsWith(s.slice(0, -1))) : active.includes(s) ? [s] : []));
  return { keys: [...new Set(keys)], remaining };
}

/**
 * Credits one run may spend so the rest of the month's credits last until the
 * month ends: an even share per remaining scheduled run, minus one kept back
 * for settling bets.
 */
export function runBudget(remaining, now, runsPerDay) {
  if (remaining == null) return Infinity;
  const d = new Date(now);
  const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const runsLeft = Math.max(1, Math.ceil(((monthEnd - now) / 864e5) * runsPerDay));
  return Math.max(0, Math.floor(remaining / runsLeft) - 1);
}

/** Whether a competition has a match starting within the look-ahead window (a free check). */
async function hasUpcoming(cfg, sport, now, fetchImpl) {
  const { data } = await fetchEvents({ apiKey: cfg.apiKey, sport, fetchImpl });
  const from = now + cfg.minLeadMinutes * 60e3;
  const to = now + cfg.lookaheadHours * 3600e3;
  return data.some((e) => { const t = Date.parse(e.commence_time); return t > from && t < to; });
}

/**
 * Returns { events, remaining, errors, skipped, overBudget, budget }.
 * `remaining` is the Odds API credits left, if known. Competitions with nothing
 * starting soon are skipped for free; once this run's share of credits is
 * spent, the lower-priority ones wait for a later run.
 */
export async function loadEvents(cfg, { sports = cfg.sports, fixture, now = Date.now(), fetchImpl = fetch } = {}) {
  if (fixture) return { events: JSON.parse(readFileSync(fixture, 'utf8')), remaining: null, errors: [], skipped: [], overBudget: [], budget: Infinity };
  if (!cfg.apiKey) throw new Error('Set ODDS_API_KEY (free key at https://the-odds-api.com) or use --fixture');
  const bookmakers = cfg.books.length ? [...SHARP_REQUEST, ...cfg.books] : undefined;
  const events = [];
  const errors = [];
  const skipped = [];
  const overBudget = [];
  const { keys, remaining: atStart } = await expandSports(cfg, sports, fetchImpl);
  let remaining = atStart;
  const budget = cfg.creditBudget ? runBudget(atStart, now, cfg.runsPerDay) : Infinity;
  let spent = 0;
  for (const sport of keys) {
    try {
      if (!(await hasUpcoming(cfg, sport, now, fetchImpl))) { skipped.push(sport); continue; }
      if (spent >= budget) { overBudget.push(sport); continue; }
      const markets = cfg.scorelines && sport.startsWith('soccer_') ? cfg.footballMarkets : cfg.markets;
      const res = await fetchOdds({ apiKey: cfg.apiKey, sport, regions: cfg.regions, bookmakers, markets, fetchImpl });
      events.push(...res.data);
      spent += res.last ?? 1;
      remaining = res.remaining ?? remaining;
    } catch (err) {
      errors.push(`${sport}: ${err.message}`);
    }
  }
  return { events, remaining, errors, skipped, overBudget, budget };
}

/**
 * Grades open bets and double legs whose games have finished. Returns what it
 * settled, plus the sports it couldn't get scores for (to settle by hand).
 */
export async function settleFinished(store, cfg, { now = new Date(), scoresFile, fetchImpl = fetch } = {}) {
  // Score lookups cost credits, so only ask once a match has had time to finish,
  // and stop asking after two days (the API only looks back three).
  const age = (iso) => (now - new Date(iso)) / 3600e3;
  const due = (iso) => age(iso) >= 2 && age(iso) < 48;
  const singles = store.open().filter((b) => due(b.commence_time));
  const doubles = store.openDoubles();
  const sports = new Set([
    ...singles.map((b) => b.sport),
    ...doubles.flatMap((d) => d.legs.filter((l) => !l.result && due(l.commenceTime)).map((l) => l.sport)),
  ]);

  const games = new Map();
  const noScores = [];
  for (const sport of sports) {
    try {
      games.set(sport, scoresFile
        ? JSON.parse(readFileSync(scoresFile, 'utf8'))
        : (await fetchScores({ apiKey: cfg.apiKey, sport, daysFrom: 3, fetchImpl })).data);
    } catch {
      noScores.push(sport);
    }
  }
  /** [home, away] final score, or null if not finished or not available. */
  const finalScore = (sport, eventId, home, away) => {
    const g = games.get(sport)?.find((x) => x.id === eventId);
    if (!g?.completed || !g.scores) return null;
    const score = (team) => Number(g.scores.find((s) => s.name === team)?.score);
    const s = [score(home), score(away)];
    return s.every(Number.isFinite) ? s : null;
  };

  const settled = [];
  for (const b of singles) {
    const s = finalScore(b.sport, b.event_id, b.home, b.away);
    if (!s) continue;
    const result = grade(b, ...s);
    store.settle(b.id, result, now);
    settled.push({ bet: b, home: s[0], away: s[1], ...result });
  }

  const settledDoubles = [];
  for (const d of doubles) {
    let changed = false;
    for (const leg of d.legs.filter((l) => !l.result)) {
      const s = finalScore(leg.sport, leg.eventId, leg.home, leg.away);
      if (!s) continue;
      leg.result = leg.market === 'correct_score'
        ? (`${s[0]}-${s[1]}` === leg.outcome ? 'won' : 'lost')
        : grade({ market: 'h2h', outcome: leg.outcome, home: leg.home, odds: leg.odds, stake: 1 }, ...s).status;
      leg.score = `${s[0]}–${s[1]}`;
      changed = true;
    }
    if (changed) store.setDoubleLegs(d.id, d.legs);
    const result = doubleOutcome(d);
    if (result) {
      store.settleDouble(d.id, result, now);
      settledDoubles.push({ double: d, ...result });
    }
  }
  return { settled, settledDoubles, noScores };
}
