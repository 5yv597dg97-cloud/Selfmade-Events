// "Fun doubles": two value selections from different matches at the same
// bookmaker, combined into one long-odds bet. If each leg is priced above its
// fair odds, so is the double: the edges multiply. They win rarely, so they
// get a small fixed stake and are tracked apart from the singles.
import { createHash } from 'node:crypto';
import { scan } from './scanner.js';

export function findDoubles(events, cfg, now = Date.now()) {
  const candidates = [];
  for (const book of cfg.books) {
    const legs = scan(events, {
      ...cfg,
      books: [book],
      minProb: 0,
      minOdds: cfg.legMinOdds,
      maxOdds: cfg.legMaxOdds,
      minEdge: cfg.legMinEdge,
      onePerEvent: true,
    }, now).filter((l) => !l.suspicious);

    for (let i = 0; i < legs.length; i++) {
      for (let j = i + 1; j < legs.length; j++) {
        const pair = [legs[i], legs[j]].sort((a, b) => a.commenceTime.localeCompare(b.commenceTime));
        const odds = Math.round(pair[0].odds * pair[1].odds * 100) / 100;
        if (odds < cfg.doubleMinOdds || odds > cfg.doubleMaxOdds) continue;
        const fairProb = pair[0].fairProb * pair[1].fairProb; // different matches, so independent
        const ev = fairProb * odds - 1;
        if (ev < cfg.doubleMinEdge) continue;
        candidates.push({
          kind: 'double',
          id: `d${createHash('sha1').update(pair.map((l) => l.id).join('|')).digest('hex').slice(0, 7)}`,
          book, bookTitle: pair[0].bookTitle,
          legs: pair.map((l) => ({
            id: l.id, eventId: l.eventId, sport: l.sport, league: l.league, commenceTime: l.commenceTime,
            home: l.home, away: l.away, market: l.market, outcome: l.outcome, odds: l.odds, fairProb: l.fairProb,
          })),
          odds, fairProb, fairOdds: 1 / fairProb, ev,
          minPrice: Math.min(odds, Math.ceil(((1 + cfg.legMinEdge) / fairProb) * 100) / 100),
          stake: cfg.doubleStake,
          commenceTime: pair[0].commenceTime,
        });
      }
    }
  }

  // Best value first; never reuse a match, so one result can't sink two doubles.
  candidates.sort((a, b) => b.ev - a.ev);
  const used = new Set();
  return candidates.filter((d) => {
    if (d.legs.some((l) => used.has(l.eventId))) return false;
    d.legs.forEach((l) => used.add(l.eventId));
    return true;
  });
}

/** "99.5" -> "98/1" (rounded, the way bookmakers quote long odds). */
export const fractional = (odds) => `${Math.round(odds - 1)}/1`;
