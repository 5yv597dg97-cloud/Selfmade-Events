// A team-strength model built from results alone, independent of the odds.
// Every team gets an attack and a defence rating; a home side's expected goals
// are home advantage x its attack x the visitor's defence (and the reverse for
// the away side). Ratings are fitted by weighted maximum likelihood (Maher /
// Dixon-Coles style), with recent matches counting most, then turned into
// match probabilities with the same scoreline model the scoreline doubles use.
import { scoreGrid, summarise } from './scorelines.js';

const DAY = 864e5;

/**
 * Fits ratings from matches played before `asOf`. Each match: { date, home,
 * away, hg, ag }. `halfLifeDays` sets how fast old results fade; `prior` pulls
 * teams with few matches toward average (in goals).
 */
export function fitRatings(matches, asOf, { halfLifeDays = 180, maxAgeDays = 730, prior = 2, iterations = 60 } = {}) {
  const used = [];
  for (const m of matches) {
    const age = (asOf - m.date) / DAY;
    if (age <= 0 || age > maxAgeDays) continue;
    used.push({ ...m, w: 0.5 ** (age / halfLifeDays) });
  }
  const teams = [...new Set(used.flatMap((m) => [m.home, m.away]))];
  const att = Object.fromEntries(teams.map((t) => [t, 1]));
  const def = Object.fromEntries(teams.map((t) => [t, 1]));
  const games = Object.fromEntries(teams.map((t) => [t, 0]));
  for (const m of used) { games[m.home] += m.w; games[m.away] += m.w; }
  let home = 1.3;
  const avgGoals = used.length ? used.reduce((a, m) => a + m.w * (m.hg + m.ag), 0) / (2 * used.reduce((a, m) => a + m.w, 0)) : 1.3;
  let base = avgGoals;

  for (let it = 0; it < iterations; it++) {
    const sNum = {}; const sDen = {}; const cNum = {}; const cDen = {};
    for (const t of teams) { sNum[t] = 0; sDen[t] = 0; cNum[t] = 0; cDen[t] = 0; }
    for (const m of used) {
      // Goals scored against expected, for attack; goals conceded against expected, for defence.
      sNum[m.home] += m.w * m.hg; sDen[m.home] += m.w * base * home * def[m.away];
      sNum[m.away] += m.w * m.ag; sDen[m.away] += m.w * base * def[m.home];
      cNum[m.away] += m.w * m.hg; cDen[m.away] += m.w * base * home * att[m.home];
      cNum[m.home] += m.w * m.ag; cDen[m.home] += m.w * base * att[m.away];
    }
    for (const t of teams) {
      att[t] = (sNum[t] + prior) / (sDen[t] + prior);
      def[t] = (cNum[t] + prior) / (cDen[t] + prior);
    }
    let hNum = 0; let hDen = 0; let gNum = 0; let gDen = 0;
    for (const m of used) {
      hNum += m.w * m.hg; hDen += m.w * base * att[m.home] * def[m.away];
      gNum += m.w * (m.hg + m.ag); gDen += m.w * (home * att[m.home] * def[m.away] + att[m.away] * def[m.home]);
    }
    home = hDen ? hNum / hDen : home;
    base = gDen ? gNum / gDen : base;
    // Fix the scale: average attack and defence are 1.
    const ma = teams.reduce((a, t) => a + att[t], 0) / teams.length;
    const md = teams.reduce((a, t) => a + def[t], 0) / teams.length;
    for (const t of teams) { att[t] /= ma; def[t] /= md; }
    base *= ma * md;
  }
  return { att, def, home, base, games, asOf };
}

/** Match probabilities, or null if either team has too little recent history. */
export function predict(r, homeTeam, awayTeam, { minGames = 6 } = {}) {
  if (!(r.games[homeTeam] >= minGames) || !(r.games[awayTeam] >= minGames)) return null;
  const lh = r.base * r.home * r.att[homeTeam] * r.def[awayTeam];
  const la = r.base * r.att[awayTeam] * r.def[homeTeam];
  const s = summarise(scoreGrid(lh, la), 2.5);
  return { home: s.home, draw: s.draw, away: s.away, over25: s.over, xg: [lh, la] };
}
