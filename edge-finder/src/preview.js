// A rundown of every match in a competition: the sharp market's chance for
// each outcome, the best price at your bookmakers, whether that price is good
// value, and the likeliest scorelines. For when you want to see the whole card,
// not just the picks.
import { SHARP_BOOKS } from './config.js';
import { fairProbabilities, marketLines } from './scanner.js';
import { likelyScorelines } from './scorelines.js';
import { statsFor } from './statsview.js';
import { esc } from './telegram.js';
import { pct, when, ukDate, icon } from './format.js';

export function previewMatch(event, cfg, now, ratings = {}) {
  const books = new Map();
  for (const b of event.bookmakers ?? []) {
    const m = b.markets?.find((x) => x.key === 'h2h');
    if (m && (now - new Date(m.last_update ?? b.last_update)) / 60000 <= cfg.maxStaleMinutes) {
      books.set(b.key, { title: b.title, outcomes: marketLines(m, event).get('h2h') });
    }
  }
  const fair = fairProbabilities(books, { ...cfg, consensus: false });
  if (!fair?.probs) return null;
  const outcomes = [...fair.probs.entries()].map(([name, p]) => {
    let best = null;
    for (const [key, b] of books) {
      if (SHARP_BOOKS.includes(key) || (cfg.books.length && !cfg.books.includes(key))) continue;
      const o = b.outcomes.find((x) => x.name === name);
      if (o && (!best || o.price > best.price)) best = { price: o.price, book: b.title };
    }
    return { name, p, fairOdds: 1 / p, best, ev: best ? p * best.price - 1 : null };
  }).sort((a, b) => b.p - a.p);
  const scores = event.sport_key?.startsWith('soccer_') ? likelyScorelines(event, { ...cfg, scorelineTopN: 3 }, now) : null;
  return { event, outcomes, scores, stats: statsFor(event, ratings) };
}

export function previewText(matches, cfg) {
  if (!matches.length) return ['No matches with sharp prices found for that competition and day.'];
  const blocks = matches.map(({ event: e, outcomes, scores, stats }) => {
    const lines = [`${icon(e.sport_key)} <b>${esc(e.home_team)} v ${esc(e.away_team)}</b> · ${when(e.commence_time)}`];
    for (const o of outcomes) {
      const price = o.best ? ` · best ${o.best.price} (${esc(o.best.book)})` : ' · not offered at your books';
      const verdict = o.ev == null ? '' : o.ev >= cfg.minEdge ? ' ✅ value' : o.ev > 0 ? ' ➖ fair' : ' ❌ poor price';
      lines.push(`${esc(o.name)} ${pct(o.p, 0)} (fair ${o.fairOdds.toFixed(2)})${price}${verdict}`);
    }
    if (stats) lines.push(`📊 Stats model (info only): ${esc(e.home_team)} ${pct(stats.home, 0)} · draw ${pct(stats.draw, 0)} · ${esc(e.away_team)} ${pct(stats.away, 0)}`);
    if (scores) lines.push(`Likeliest scores: ${scores.top.map((s) => `${s.score} (${pct(s.p, 0)})`).join(', ')}`);
    return lines.join('\n');
  });
  const head = '<b>Match preview</b>: chances from the sharp market. Nothing here is certain; even the biggest favourite loses sometimes. ✅ means the price is better than fair. 📊 is a model built from past results only: tested on 4,770 matches it was less accurate than the market, so it is shown for interest and never used for picks.';
  // Telegram messages are limited to 4096 characters.
  const messages = [head];
  for (const b of blocks) {
    if (messages.at(-1).length + b.length + 2 > 4000) messages.push(b);
    else messages[messages.length - 1] += `\n\n${b}`;
  }
  return messages;
}

/** Matches starting later today (UK time), or within `hours` if given. */
export function previewMatches(events, cfg, now, { today = true, hours = 24, ratings = {} } = {}) {
  return events
    .filter((e) => {
      const t = Date.parse(e.commence_time);
      if (t <= now) return false;
      return today ? ukDate(t) === ukDate(now) : t - now <= hours * 3600e3;
    })
    .sort((a, b) => a.commence_time.localeCompare(b.commence_time))
    .map((e) => previewMatch(e, cfg, now, ratings))
    .filter(Boolean);
}
