// Would the results-based model have helped? Walks through past seasons one
// matchday at a time, fitting the model only on matches already played, and
// compares it with the market (Pinnacle's de-vigged odds):
//   1. Accuracy: average log loss of model, market and a blend of the two.
//      If the blend beats the market alone, the model adds information.
//   2. Betting: the system's value bets (a soft bookmaker beating Pinnacle's
//      fair price), with and without "the model agrees" as a filter.
import { devig } from './devig.js';
import { fitRatings, predict } from './ratings.js';

const OUTCOMES = ['home', 'draw', 'away'];
const resultIndex = (m) => (m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2);

function bucket() { return { n: 0, staked: 0, pnl: 0, wins: 0 }; }
function addBet(b, won, odds) { b.n++; b.staked++; b.pnl += won ? odds - 1 : -1; if (won) b.wins++; }
const summary = (b) => ({ bets: b.n, winRate: b.n ? b.wins / b.n : 0, roi: b.staked ? b.pnl / b.staked : 0, profit: b.pnl });

export function backtest(matches, { testSeasons, halfLifeDays = 180, blend = 0.2, minEdge = 0.02, minProb = 0.75, softBooks = ['bet365', 'williamhill'] } = {}) {
  const loss = { model: 0, market: 0, blend: 0, n: 0 };
  const bets = { all: bucket(), allAgree: bucket(), allDisagree: bucket(), safe: bucket(), safeAgree: bucket(), safeDisagree: bucket(), modelOnly: bucket() };
  const byLeague = {};

  const leagues = [...new Set(matches.map((m) => m.league))];
  for (const league of leagues) {
    const lm = matches.filter((m) => m.league === league);
    const tests = lm.filter((m) => testSeasons.includes(m.season));
    const dates = [...new Set(tests.map((m) => m.date))].sort((a, b) => a - b);
    const L = (byLeague[league] = { model: 0, market: 0, blend: 0, n: 0 });
    for (const date of dates) {
      const r = fitRatings(lm, date, { halfLifeDays });
      for (const m of tests.filter((x) => x.date === date)) {
        const fairOdds = m.odds.pinnacleClose ?? m.odds.pinnacle;
        if (!fairOdds) continue;
        const p = predict(r, m.home, m.away);
        if (!p) continue;
        const model = OUTCOMES.map((o) => p[o]);
        const market = devig(fairOdds, 'power');
        const mix = market.map((x, i) => (1 - blend) * x + blend * model[i]);
        const k = resultIndex(m);
        for (const [key, probs] of [['model', model], ['market', market], ['blend', mix]]) {
          const ll = -Math.log(Math.max(probs[k], 1e-6));
          loss[key] += ll; L[key] += ll;
        }
        loss.n++; L.n++;

        // Betting uses the earlier Pinnacle price (when you'd actually bet), not the close.
        const early = m.odds.pinnacle;
        if (!early) continue;
        const fair = devig(early, 'power');
        for (let i = 0; i < 3; i++) {
          const best = Math.max(...softBooks.map((b) => m.odds[b]?.[i] ?? 0));
          if (best <= 1) continue;
          const won = i === k;
          if (fair[i] * best - 1 >= minEdge) {
            const agree = model[i] * best > 1;
            addBet(bets.all, won, best);
            addBet(agree ? bets.allAgree : bets.allDisagree, won, best);
            if (fair[i] >= minProb) {
              addBet(bets.safe, won, best);
              addBet(agree ? bets.safeAgree : bets.safeDisagree, won, best);
            }
          }
          // The model on its own, ignoring the market: does it find value?
          if (model[i] * best - 1 >= 0.05) addBet(bets.modelOnly, won, best);
        }
      }
    }
  }
  const avg = (x) => ({ model: x.model / x.n, market: x.market / x.n, blend: x.blend / x.n, matches: x.n });
  return {
    accuracy: avg(loss),
    byLeague: Object.fromEntries(Object.entries(byLeague).filter(([, x]) => x.n).map(([k, x]) => [k, avg(x)])),
    bets: Object.fromEntries(Object.entries(bets).map(([k, b]) => [k, summary(b)])),
  };
}

/**
 * Replays a trixie a week from real results: legs are each match's favourite
 * by the early Pinnacle price, one leg per match. Strategies:
 *   strongest: the week's 3 biggest favourites, at `book` prices
 *   strongestBest: the same at the best price any bookmaker offered
 *   value: only 75%+ legs priced at least fair at `book`, trixie 2%+ above fair
 */
export function trixieBacktest(matches, { seasons, book = 'bet365', minProbs = [0.75, 0.65, 0.5], minEdge = 0.02 } = {}) {
  const week = (t) => { const d = new Date(t); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const weeks = new Map();
  for (const m of matches) {
    if (!seasons.includes(m.season) || !m.odds.pinnacle) continue;
    const fair = devig(m.odds.pinnacle, 'power');
    const i = fair[0] >= fair[2] ? 0 : 2; // favourite side; draws are never favourites
    const won = (i === 0 && m.hg > m.ag) || (i === 2 && m.ag > m.hg);
    const leg = { match: `${m.home} v ${m.away}`, team: i === 0 ? m.home : m.away, p: fair[i], won, price: m.odds[book]?.[i], best: m.odds.max?.[i] };
    if (!weeks.has(week(m.date))) weeks.set(week(m.date), []);
    weeks.get(week(m.date)).push(leg);
  }

  const pairs = [[0, 1], [0, 2], [1, 2]];
  const settle = (legs, priceKey) => {
    const o = legs.map((l) => (l.won ? l[priceKey] : 0));
    return pairs.reduce((a, [i, j]) => a + o[i] * o[j], 0) + o[0] * o[1] * o[2] - 4; // units, 4 staked
  };
  const fresh = () => ({ trixies: 0, allThree: 0, returned: 0, profit: 0, worstRun: 0, run: 0, peak: 0, low: 0, examples: [] });
  const record = (s, legs, priceKey, label) => {
    const wins = legs.filter((l) => l.won).length;
    const pnl = settle(legs, priceKey);
    s.trixies++; s.profit += pnl;
    if (wins === 3) s.allThree++;
    if (wins >= 2) s.returned++;
    s.run = wins >= 2 ? 0 : s.run + 1; s.worstRun = Math.max(s.worstRun, s.run);
    s.peak = Math.max(s.peak, s.profit); s.low = Math.min(s.low, s.profit - s.peak);
    if (wins < 3 && s.examples.length < 3) s.examples.push(`${label}: ${legs.filter((l) => !l.won).map((l) => `${l.team} (${Math.round(l.p * 100)}%) didn't win`).join(', ')}`);
  };
  const out = { strongest: fresh(), strongestBest: fresh(), value: {} };
  for (const p of minProbs) out.value[p] = fresh();
  let favouriteFailed = 0;
  for (const [label, legs] of [...weeks.entries()].sort()) {
    const ranked = legs.filter((l) => l.price > 1 && l.best > 1).sort((a, b) => b.p - a.p);
    if (ranked.length < 3) continue;
    if (!ranked[0].won) favouriteFailed++;
    record(out.strongest, ranked.slice(0, 3), 'price', label);
    record(out.strongestBest, ranked.slice(0, 3), 'best', label);
    // The system's rules: likely and priced at least fair, then the best-value three.
    for (const minProb of minProbs) {
      const value = ranked.filter((l) => l.p >= minProb && l.p * l.price >= 1).sort((a, b) => b.p * b.price - a.p * a.price).slice(0, 3);
      if (value.length < 3) continue;
      const ev = (pairs.reduce((a, [i, j]) => a + value[i].p * value[i].price * value[j].p * value[j].price, 0)
        + value.reduce((a, l) => a * l.p * l.price, 1)) / 4 - 1;
      if (ev >= minEdge) record(out.value[minProb], value, 'price', label);
    }
  }
  const weeksPlayed = out.strongest.trixies;
  for (const s of [out.strongest, out.strongestBest, ...Object.values(out.value)]) s.roi = s.trixies ? s.profit / (4 * s.trixies) : 0;
  return { weeks: weeksPlayed, favouriteFailed, ...out };
}
