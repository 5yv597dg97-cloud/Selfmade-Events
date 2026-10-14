// Fair correct-score odds for football, worked out from the sharp market's
// match result and total goals prices. Each side's expected goals is fitted so
// a Poisson model (with the Dixon-Coles correction for low scores, which makes
// 0-0 and 1-1 a little likelier) reproduces those prices; every scoreline's
// chance then follows. Bookmakers' own correct-score prices aren't in the odds
// data, so picks give the lowest price worth taking and you check it yourself.
import { createHash } from 'node:crypto';
import { SHARP_BOOKS } from './config.js';
import { devig } from './devig.js';
import { marketLines } from './scanner.js';

const MAX_GOALS = 10;
const RHO = -0.1; // typical Dixon-Coles low-score correlation for top leagues

const poisson = (k, l) => {
  let p = Math.exp(-l);
  for (let i = 1; i <= k; i++) p *= l / i;
  return p;
};

/** Probability of every scoreline: grid[h][a]. */
export function scoreGrid(lh, la, rho = RHO) {
  const ph = Array.from({ length: MAX_GOALS + 1 }, (_, k) => poisson(k, lh));
  const pa = Array.from({ length: MAX_GOALS + 1 }, (_, k) => poisson(k, la));
  const tau = (h, a) => {
    if (h === 0 && a === 0) return 1 - lh * la * rho;
    if (h === 0 && a === 1) return 1 + lh * rho;
    if (h === 1 && a === 0) return 1 + la * rho;
    if (h === 1 && a === 1) return 1 - rho;
    return 1;
  };
  const grid = ph.map((x, h) => pa.map((y, a) => x * y * tau(h, a)));
  const total = grid.flat().reduce((s, x) => s + x, 0);
  return grid.map((row) => row.map((x) => x / total));
}

/** Home win, draw, away win, and P(over) / P(push) for a total goals line. */
export function summarise(grid, line) {
  let home = 0; let draw = 0; let away = 0; let over = 0; let push = 0;
  grid.forEach((row, h) => row.forEach((p, a) => {
    if (h > a) home += p; else if (h === a) draw += p; else away += p;
    if (h + a > line) over += p; else if (h + a === line) push += p;
  }));
  return { home, draw, away, over, push };
}

/** Expected goals for each side that best reproduce the market's prices. */
export function fitGoals({ home, away, over, line }) {
  const err = (lh, la) => {
    const s = summarise(scoreGrid(lh, la), line);
    // On a whole-number line a push refunds, so the market prices over against under only.
    const o = s.over / (1 - s.push);
    return (s.home - home) ** 2 + (s.away - away) ** 2 + (o - over) ** 2;
  };
  let best = { lh: 1.4, la: 1.1, e: Infinity };
  for (const step of [0.1, 0.02, 0.005]) {
    const range = step === 0.1 ? [0.1, 4.5] : null;
    const [lo1, hi1] = range ?? [best.lh - step * 5, best.lh + step * 5];
    const [lo2, hi2] = range ?? [best.la - step * 5, best.la + step * 5];
    for (let lh = Math.max(0.05, lo1); lh <= hi1 + 1e-9; lh += step) {
      for (let la = Math.max(0.05, lo2); la <= hi2 + 1e-9; la += step) {
        const e = err(lh, la);
        if (e < best.e) best = { lh, la, e };
      }
    }
  }
  return best;
}

/**
 * The sharp market's view of one football match: de-vigged match result and
 * the total goals line closest to 2.5 (half or whole lines only). Null if the
 * sharp books don't have both.
 */
export function sharpView(event, cfg, now) {
  const fresh = (m, b) => (now - new Date(m.last_update ?? b.last_update)) / 60000 <= cfg.maxStaleMinutes;
  const results = [];
  const totals = new Map();
  for (const book of event.bookmakers ?? []) {
    if (!SHARP_BOOKS.includes(book.key)) continue;
    for (const m of book.markets ?? []) {
      if (!fresh(m, book)) continue;
      if (m.key === 'h2h' && m.outcomes.length === 3) {
        const p = devig(m.outcomes.map((o) => o.price), cfg.devigMethod);
        const by = Object.fromEntries(m.outcomes.map((o, i) => [o.name, p[i]]));
        if (by[event.home_team] && by[event.away_team]) results.push({ home: by[event.home_team], away: by[event.away_team] });
      }
      if (m.key === 'totals') {
        for (const [line, outs] of marketLines(m, event)) {
          const l = Number(line);
          if ((l * 2) % 1 !== 0 || outs.length !== 2) continue; // skip quarter lines
          const p = devig(outs.map((o) => o.price), cfg.devigMethod);
          const over = p[outs.findIndex((o) => o.name === 'Over')];
          if (over === undefined) continue;
          if (!totals.has(l)) totals.set(l, []);
          totals.get(l).push(over);
        }
      }
    }
  }
  if (!results.length || !totals.size) return null;
  const line = [...totals.keys()].sort((a, b) => Math.abs(a - 2.5) - Math.abs(b - 2.5))[0];
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    home: mean(results.map((r) => r.home)),
    away: mean(results.map((r) => r.away)),
    over: mean(totals.get(line)),
    line,
  };
}

/** The likeliest scorelines for a match, with fair odds. */
export function likelyScorelines(event, cfg, now) {
  const view = sharpView(event, cfg, now);
  if (!view) return null;
  const { lh, la } = fitGoals(view);
  const grid = scoreGrid(lh, la);
  const all = grid.flatMap((row, h) => row.map((p, a) => ({ score: `${h}-${a}`, p })));
  all.sort((x, y) => y.p - x.p);
  return { xg: [lh, la], top: all.slice(0, cfg.scorelineTopN) };
}

/**
 * Pairs scorelines from two matches into doubles near 99/1. Each leg's price
 * to look for is its fair odds plus the edge you need, so the double is only
 * worth placing if the bookmaker beats both.
 */
export function findScorelineDoubles(events, cfg, now = Date.now()) {
  const legs = [];
  for (const e of events) {
    if (!e.sport_key?.startsWith('soccer_')) continue;
    if ((Date.parse(e.commence_time) - now) / 60000 < cfg.minLeadMinutes) continue;
    const m = likelyScorelines(e, cfg, now);
    if (!m) continue;
    for (const s of m.top) {
      legs.push({
        id: `${e.id}|${s.score}`, eventId: e.id, sport: e.sport_key, league: e.sport_title ?? e.sport_key,
        commenceTime: e.commence_time, home: e.home_team, away: e.away_team,
        market: 'correct_score', outcome: s.score, fairProb: s.p,
        odds: Math.ceil((1 + cfg.scorelineLegEdge) / s.p * 100) / 100, // lowest price worth taking
      });
    }
  }

  const candidates = [];
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      if (legs[i].eventId === legs[j].eventId) continue;
      const pair = [legs[i], legs[j]].sort((a, b) => a.commenceTime.localeCompare(b.commenceTime));
      const odds = Math.round(pair[0].odds * pair[1].odds * 100) / 100;
      if (odds < cfg.doubleMinOdds || odds > cfg.doubleMaxOdds) continue;
      const fairProb = pair[0].fairProb * pair[1].fairProb;
      candidates.push({
        kind: 'double', type: 'scoreline',
        id: `s${createHash('sha1').update(pair.map((l) => l.id).join('|')).digest('hex').slice(0, 7)}`,
        book: 'any', bookTitle: 'your bookmaker',
        legs: pair, odds, fairProb, fairOdds: 1 / fairProb, ev: fairProb * odds - 1,
        minPrice: odds, stake: cfg.doubleStake, commenceTime: pair[0].commenceTime,
      });
    }
  }
  // Closest to 99/1 first, preferring likelier scorelines; never reuse a match.
  candidates.sort((a, b) => Math.abs(Math.log(a.odds / cfg.scorelineTarget)) - Math.abs(Math.log(b.odds / cfg.scorelineTarget)));
  const used = new Set();
  return candidates.filter((d) => {
    if (d.legs.some((l) => used.has(l.eventId))) return false;
    d.legs.forEach((l) => used.add(l.eventId));
    return true;
  });
}
