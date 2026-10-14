// Getting odds and scores, from The Odds API or from local files for testing.
import { readFileSync } from 'node:fs';
import { fetchEvents, fetchOdds, fetchScores, fetchSports } from './odds-api.js';
import { grade } from './settle.js';

// The sharp books we need in every request when naming bookmakers explicitly.
const SHARP_REQUEST = ['pinnacle', 'betfair_ex_uk'];

/** Turns "tennis_*" into every tennis competition currently open (the sports list costs no credits). */
export async function expandSports(cfg, sports, fetchImpl = fetch) {
  if (!sports.some((s) => s.endsWith('*'))) return sports;
  const { data } = await fetchSports({ apiKey: cfg.apiKey, fetchImpl });
  const active = data.filter((s) => s.active && !s.has_outrights).map((s) => s.key);
  return [...new Set(sports.flatMap((s) => (s.endsWith('*') ? active.filter((k) => k.startsWith(s.slice(0, -1))) : [s])))];
}

/** Whether a competition has a match starting within the look-ahead window (a free check). */
async function hasUpcoming(cfg, sport, now, fetchImpl) {
  const { data } = await fetchEvents({ apiKey: cfg.apiKey, sport, fetchImpl });
  const from = now + cfg.minLeadMinutes * 60e3;
  const to = now + cfg.lookaheadHours * 3600e3;
  return data.some((e) => { const t = Date.parse(e.commence_time); return t > from && t < to; });
}

/**
 * Returns { events, remaining, errors, skipped }; `remaining` is the Odds API
 * credits left, if known. Competitions with nothing starting soon are skipped
 * without spending credits.
 */
export async function loadEvents(cfg, { sports = cfg.sports, fixture, now = Date.now(), fetchImpl = fetch } = {}) {
  if (fixture) return { events: JSON.parse(readFileSync(fixture, 'utf8')), remaining: null, errors: [], skipped: [] };
  if (!cfg.apiKey) throw new Error('Set ODDS_API_KEY (free key at https://the-odds-api.com) or use --fixture');
  const bookmakers = cfg.books.length ? [...SHARP_REQUEST, ...cfg.books] : undefined;
  const events = [];
  const errors = [];
  const skipped = [];
  let remaining = null;
  for (const sport of await expandSports(cfg, sports, fetchImpl)) {
    try {
      if (!(await hasUpcoming(cfg, sport, now, fetchImpl))) { skipped.push(sport); continue; }
      const res = await fetchOdds({ apiKey: cfg.apiKey, sport, regions: cfg.regions, bookmakers, markets: cfg.markets, fetchImpl });
      events.push(...res.data);
      remaining = res.remaining;
    } catch (err) {
      errors.push(`${sport}: ${err.message}`);
    }
  }
  return { events, remaining: remaining == null ? null : Number(remaining), errors, skipped };
}

/**
 * Grades open bets whose games have finished. Returns one entry per bet it
 * settled, plus the sports it couldn't get scores for (to settle by hand).
 */
export async function settleFinished(store, cfg, { now = new Date(), scoresFile, fetchImpl = fetch } = {}) {
  // Score lookups cost credits, so only ask once a match has had time to finish,
  // and stop asking after two days (the API only looks back three).
  const age = (b) => (now - new Date(b.commence_time)) / 3600e3;
  const started = store.open().filter((b) => age(b) >= 2 && age(b) < 48);
  const settled = [];
  const noScores = [];
  for (const sport of new Set(started.map((b) => b.sport))) {
    let games;
    try {
      games = scoresFile
        ? JSON.parse(readFileSync(scoresFile, 'utf8'))
        : (await fetchScores({ apiKey: cfg.apiKey, sport, daysFrom: 3, fetchImpl })).data;
    } catch {
      noScores.push(sport);
      continue;
    }
    for (const b of started.filter((x) => x.sport === sport)) {
      const g = games.find((x) => x.id === b.event_id);
      if (!g?.completed || !g.scores) continue;
      const score = (team) => Number(g.scores.find((s) => s.name === team)?.score);
      const [h, a] = [score(b.home), score(b.away)];
      if (!Number.isFinite(h) || !Number.isFinite(a)) continue;
      const result = grade(b, h, a);
      store.settle(b.id, result, now);
      settled.push({ bet: b, home: h, away: a, ...result });
    }
  }
  return { settled, noScores };
}
