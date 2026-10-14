import { createHash } from 'node:crypto';
import { SHARP_BOOKS } from './config.js';
import { devig } from './devig.js';
import { expectedValue, kellyFraction, logGrowth, stake } from './kelly.js';

/**
 * Splits one bookmaker market into comparable lines. h2h is a single line;
 * totals are keyed by the total; spreads by the home team's handicap, so
 * "Home -1.5 / Away +1.5" from every book lands under the same key.
 */
export function marketLines(market, event) {
  const lines = new Map();
  for (const o of market.outcomes) {
    let key;
    if (market.key === 'h2h') key = 'h2h';
    else if (market.key === 'totals') key = String(o.point);
    else if (market.key === 'spreads') key = String(o.name === event.home_team ? o.point : -o.point);
    else continue;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push({ name: o.name, point: o.point ?? null, price: o.price });
  }
  return lines;
}

const minutesSince = (iso, now) => (now - new Date(iso).getTime()) / 60000;

/** Collects every fresh price per market/line: Map<"market|line", {market, line, books: Map<bookKey, {...}>}>. */
export function collectLines(event, cfg, now) {
  const all = new Map();
  for (const book of event.bookmakers ?? []) {
    for (const market of book.markets ?? []) {
      if (!cfg.marketList.includes(market.key)) continue;
      if (minutesSince(market.last_update ?? book.last_update, now) > cfg.maxStaleMinutes) continue;
      for (const [line, outcomes] of marketLines(market, event)) {
        const id = `${market.key}|${line}`;
        if (!all.has(id)) all.set(id, { market: market.key, line, books: new Map() });
        all.get(id).books.set(book.key, { title: book.title, outcomes });
      }
    }
  }
  return all;
}

/**
 * Fair probability for each outcome name on one line. Uses the de-vigged sharp
 * books (averaged if several), or, when allowed, the median de-vigged price
 * across all books. Returns null if no trustworthy source exists.
 */
export function fairProbabilities(lineBooks, cfg) {
  const width = Math.max(...[...lineBooks.values()].map((b) => b.outcomes.length));
  const devigBook = (b) => {
    const probs = devig(b.outcomes.map((o) => o.price), cfg.devigMethod);
    return new Map(b.outcomes.map((o, i) => [o.name, probs[i]]));
  };
  const complete = [...lineBooks.entries()].filter(([, b]) => b.outcomes.length === width && width >= 2);

  const sharps = complete.filter(([key]) => SHARP_BOOKS.includes(key));
  if (sharps.length) {
    return { probs: average(sharps.map(([, b]) => devigBook(b))), source: sharps.map(([k]) => k).join('+') };
  }
  if (cfg.consensus && complete.length >= cfg.minConsensusBooks) {
    return { probs: median(complete.map(([, b]) => devigBook(b))), source: `consensus of ${complete.length}` };
  }
  return null;
}

function average(maps) {
  const out = new Map();
  for (const name of maps[0].keys()) {
    out.set(name, maps.reduce((a, m) => a + (m.get(name) ?? NaN), 0) / maps.length);
  }
  return [...out.values()].some(Number.isNaN) ? null : out;
}

function median(maps) {
  const out = new Map();
  for (const name of maps[0].keys()) {
    const xs = maps.map((m) => m.get(name)).filter((x) => x !== undefined).sort((a, b) => a - b);
    const mid = xs.length >> 1;
    out.set(name, xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2);
  }
  const sum = [...out.values()].reduce((a, b) => a + b, 0);
  for (const [k, v] of out) out.set(k, v / sum);
  return out;
}

export function pickId(eventId, market, line, outcome, book) {
  return createHash('sha1').update([eventId, market, line, outcome, book].join('|')).digest('hex').slice(0, 8);
}

/** Every value bet across the given events, best first. */
export function scan(events, cfg, now = Date.now()) {
  const candidates = [];
  for (const event of events) {
    if (minutesSince(event.commence_time, now) > -cfg.minLeadMinutes) continue; // started or about to
    for (const { market, line, books } of collectLines(event, cfg, now).values()) {
      const fair = fairProbabilities(books, cfg);
      if (!fair?.probs) continue;

      for (const [bookKey, book] of books) {
        if (SHARP_BOOKS.includes(bookKey)) continue;
        if (cfg.books.length && !cfg.books.includes(bookKey)) continue;
        for (const o of book.outcomes) {
          const p = fair.probs.get(o.name);
          if (p === undefined) continue;
          const ev = expectedValue(p, o.price);
          if (ev < cfg.minEdge || p < cfg.minProb || o.price < cfg.minOdds || o.price > cfg.maxOdds) continue;
          candidates.push({
            id: pickId(event.id, market, line, o.name, bookKey),
            eventId: event.id,
            sport: event.sport_key,
            league: event.sport_title ?? event.sport_key,
            commenceTime: event.commence_time,
            home: event.home_team,
            away: event.away_team,
            market, line, outcome: o.name, point: o.point,
            book: bookKey, bookTitle: book.title,
            odds: o.price,
            fairProb: p,
            fairOdds: 1 / p,
            ev,
            fairSource: fair.source,
            // An edge this large is far likelier a stale price or a mismatched
            // line than a real mistake by the book.
            suspicious: ev > cfg.maxEdge,
          });
        }
      }
    }
  }

  // Keep the best price per outcome; remember the other books offering value on it.
  const byOutcome = new Map();
  for (const c of candidates) {
    const k = `${c.eventId}|${c.market}|${c.line}|${c.outcome}`;
    const best = byOutcome.get(k);
    if (!best) byOutcome.set(k, { ...c, alsoAt: [] });
    else if (c.odds > best.odds) byOutcome.set(k, { ...c, alsoAt: [...best.alsoAt, `${best.bookTitle} ${best.odds}`] });
    else best.alsoAt.push(`${c.bookTitle} ${c.odds}`);
  }

  let picks = [...byOutcome.values()].map((pick) => {
    const s = pick.suspicious
      ? { f: 0, amount: 0 }
      : stake({ p: pick.fairProb, odds: pick.odds, bankroll: cfg.bankroll, fraction: cfg.kellyFraction, maxStakePct: cfg.maxStakePct });
    // Lowest price that still clears the minimum edge, for when the odds drift before you bet.
    const minPrice = Math.min(pick.odds, Math.ceil(((1 + cfg.minEdge) / pick.fairProb) * 100) / 100);
    return { ...pick, minPrice, kelly: kellyFraction(pick.fairProb, pick.odds), stakeFraction: s.f, stake: s.amount, growth: logGrowth(pick.fairProb, pick.odds, s.f) };
  });
  picks.sort((a, b) => a.suspicious - b.suspicious || b.growth - a.growth);

  // Bets on the same match are correlated; by default take only the best one.
  if (cfg.onePerEvent) {
    const seen = new Set();
    picks = picks.filter((p) => !seen.has(p.eventId) && seen.add(p.eventId));
  }
  return picks;
}

/** Current fair probability for a logged bet's outcome, or null if the line is no longer offered by a sharp book. */
export function currentFairProb(events, bet, cfg, now = Date.now()) {
  const event = events.find((e) => e.id === bet.event_id);
  if (!event) return null;
  const line = collectLines(event, { ...cfg, marketList: [bet.market] }, now).get(`${bet.market}|${bet.line}`);
  if (!line) return null;
  const fair = fairProbabilities(line.books, { ...cfg, consensus: false });
  return fair?.probs?.get(bet.outcome) ?? null;
}
