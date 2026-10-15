// Trixies: three selections from different matches, staked as four bets (the
// three doubles and the treble). Any two winners return something. Legs come
// from the same pool as the singles (likely outcomes priced at least fair), so
// if every leg is good value, every line of the trixie is too.
import { createHash } from 'node:crypto';
import { scan } from './scanner.js';

const PAIRS = [[0, 1], [0, 2], [1, 2]];

/** Return per unit staked on each line, given each leg's settled odds (won: its price, void: 1, lost: 0). */
export const trixieReturn = (o) => PAIRS.reduce((a, [i, j]) => a + o[i] * o[j], 0) + o[0] * o[1] * o[2];

/** Chances and returns of a trixie from each leg's fair chance and price. */
export function trixieStats(legs) {
  let ev = 0; let pAll = 0; let pTwo = 0;
  for (let mask = 0; mask < 8; mask++) {
    const won = [0, 1, 2].map((i) => Boolean(mask & (1 << i)));
    const prob = legs.reduce((a, l, i) => a * (won[i] ? l.fairProb : 1 - l.fairProb), 1);
    ev += prob * trixieReturn(legs.map((l, i) => (won[i] ? l.odds : 0)));
    const wins = won.filter(Boolean).length;
    if (wins === 3) pAll += prob; else if (wins === 2) pTwo += prob;
  }
  const o = legs.map((l) => l.odds);
  return {
    pAll, pTwo, pNothing: 1 - pAll - pTwo,
    returnAll: trixieReturn(o), // in units, out of 4 staked
    returnTwo: PAIRS.map(([i, j]) => o[i] * o[j]), // whichever two win
    ev: ev / 4 - 1,
  };
}

export function findTrixies(events, cfg, now = Date.now()) {
  const found = [];
  for (const book of cfg.books) {
    const legs = scan(events, {
      ...cfg, books: [book], minProb: cfg.trixieLegMinProb, minEdge: cfg.trixieLegMinEdge,
      minOdds: 1.05, maxOdds: cfg.trixieLegMaxOdds, onePerEvent: true,
    }, now).filter((l) => !l.suspicious).sort((a, b) => b.ev - a.ev).slice(0, 8);
    for (let a = 0; a < legs.length; a++) for (let b = a + 1; b < legs.length; b++) for (let c = b + 1; c < legs.length; c++) {
      const trio = [legs[a], legs[b], legs[c]].sort((x, y) => x.commenceTime.localeCompare(y.commenceTime));
      const stats = trixieStats(trio);
      if (stats.ev < cfg.trixieMinEdge) continue;
      found.push({
        kind: 'trixie',
        id: `t${createHash('sha1').update(trio.map((l) => l.id).join('|')).digest('hex').slice(0, 7)}`,
        book, bookTitle: trio[0].bookTitle,
        legs: trio.map((l) => ({
          id: l.id, eventId: l.eventId, sport: l.sport, league: l.league, commenceTime: l.commenceTime,
          home: l.home, away: l.away, market: l.market, outcome: l.outcome, odds: l.odds, fairProb: l.fairProb, minPrice: l.minPrice,
        })),
        ...stats,
        odds: stats.returnAll / 4 + 0, // average return per unit if all win, for the record
        fairProb: stats.pAll,
        unit: cfg.trixieUnitStake,
        stake: Math.round(cfg.trixieUnitStake * 4 * 100) / 100,
        commenceTime: trio[0].commenceTime,
      });
    }
  }
  found.sort((x, y) => y.ev - x.ev);
  const used = new Set();
  return found.filter((t) => {
    if (t.legs.some((l) => used.has(l.eventId))) return false;
    t.legs.forEach((l) => used.add(l.eventId));
    return true;
  });
}

/** Settles a trixie from its legs' results; null while it could still go either way. */
export function trixieOutcome({ legs, stake }) {
  const lost = legs.filter((l) => l.result === 'lost').length;
  if (lost >= 2) return { status: 'lost', pnl: -stake };
  if (!legs.every((l) => l.result)) return null;
  const unit = stake / 4;
  const ret = trixieReturn(legs.map((l) => (l.result === 'won' ? l.odds : l.result === 'void' ? 1 : 0)));
  const pnl = Math.round((unit * ret - stake) * 100) / 100;
  return { status: pnl > 0 ? 'won' : ret === 0 ? 'lost' : 'part', pnl };
}

/**
 * The weekly "banker trixie": the three biggest football favourites starting
 * within the window, at whichever of your bookmakers prices them best. Not a
 * value bet: a backtest over 103 weeks found it paid something back 96% of
 * weeks and roughly broke even.
 */
export function findBankerTrixie(events, cfg, now = Date.now()) {
  const soon = events.filter((e) => e.sport_key?.startsWith('soccer_')
    && Date.parse(e.commence_time) - now <= cfg.bankerWindowHours * 3600e3);
  let best = null;
  for (const book of cfg.books) {
    const prices = scan(soon, {
      ...cfg, books: [book], minProb: 0, minEdge: -1, minOdds: 1.01, maxOdds: 1000, onePerEvent: false,
    }, now).filter((l) => !l.suspicious && l.outcome !== 'Draw');
    // Each match's favourite, then the three strongest.
    const fav = new Map();
    for (const l of prices) if (!fav.has(l.eventId) || l.fairProb > fav.get(l.eventId).fairProb) fav.set(l.eventId, l);
    const trio = [...fav.values()].sort((a, b) => b.fairProb - a.fairProb).slice(0, 3);
    if (trio.length < 3) continue;
    const stats = trixieStats(trio);
    if (!best || stats.ev > best.ev) best = { book, trio, ...stats };
  }
  if (!best) return null;
  const trio = best.trio.sort((x, y) => x.commenceTime.localeCompare(y.commenceTime));
  return {
    kind: 'trixie', banker: true,
    id: `b${createHash('sha1').update(trio.map((l) => l.id).join('|')).digest('hex').slice(0, 7)}`,
    book: best.book, bookTitle: trio[0].bookTitle,
    legs: trio.map((l) => ({
      id: l.id, eventId: l.eventId, sport: l.sport, league: l.league, commenceTime: l.commenceTime,
      home: l.home, away: l.away, market: l.market, outcome: l.outcome, odds: l.odds, fairProb: l.fairProb,
    })),
    pAll: best.pAll, pTwo: best.pTwo, pNothing: best.pNothing, returnAll: best.returnAll, returnTwo: best.returnTwo, ev: best.ev,
    odds: best.returnAll / 4, fairProb: best.pAll,
    unit: cfg.bankerUnitStake, stake: Math.round(cfg.bankerUnitStake * 4 * 100) / 100,
    commenceTime: trio[0].commenceTime,
  };
}
