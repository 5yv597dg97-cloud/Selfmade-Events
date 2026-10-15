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
