import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { previewMatches, previewText } from '../src/preview.js';

const events = JSON.parse(readFileSync(new URL('../fixtures/sample-odds.json', import.meta.url)));
const NOW = Date.parse('2026-10-14T12:00:00Z');
const cfg = loadConfig({}, {});

test('previews each match with chances, best price, verdict and scores', () => {
  const matches = previewMatches(events, cfg, NOW, { today: false, hours: 120 });
  const city = matches.find((m) => m.event.id === 'evt_mci_wol');
  assert.deepEqual(city.outcomes.map((o) => o.name), ['Manchester City', 'Draw', 'Wolverhampton Wanderers']);
  assert.equal(city.outcomes[0].best.book, 'Paddy Power');
  assert.ok(city.outcomes[0].ev < 0 && city.outcomes[2].ev > 0.015);
  assert.equal(city.scores.top.length, 3);
  assert.ok(!matches.some((m) => m.event.id === 'evt_live'), 'started matches left out');

  const [text] = previewText(matches, cfg);
  assert.match(text, /⚽ <b>Manchester City v Wolverhampton Wanderers<\/b>/);
  assert.match(text, /🎾 <b>Jannik Sinner v Hugo Gaston/);
  assert.match(text, /Wolverhampton Wanderers 8% \(fair 12\.\d\d\) · best 13 \(Paddy Power\) ✅ value/);
  assert.match(text, /Likeliest scores: 2-0/);
});

test('today means the rest of the UK day', () => {
  assert.deepEqual(previewMatches(events, cfg, NOW), []);
  assert.deepEqual(previewText([], cfg), ['No matches with sharp prices found for that competition and day.']);
});

import { fitRatings } from '../src/ratings.js';

test('shows the stats model alongside, when it can rate both teams', () => {
  // A small made-up history where Man City beat everyone and Wolves lose to everyone.
  const teams = ['Man City', 'Wolves', 'Arsenal', 'Everton', 'Liverpool', 'Burnley'];
  const history = [];
  let date = Date.parse('2026-01-01');
  for (let r = 0; r < 4; r++) for (const h of teams) for (const a of teams) {
    if (h === a) continue;
    const s = (t) => ({ 'Man City': 3, Liverpool: 2, Arsenal: 2, Everton: 1, Burnley: 1, Wolves: 0 })[t];
    history.push({ league: 'E0', date, home: h, away: a, hg: s(h), ag: Math.max(0, s(a) - 1) });
    date += 864e5;
  }
  const ratings = { E0: fitRatings(history, NOW, { halfLifeDays: 365 }) };
  const matches = previewMatches(events, cfg, NOW, { today: false, hours: 120, ratings });
  const city = matches.find((m) => m.event.id === 'evt_mci_wol');
  assert.ok(city.stats.home > 0.7, 'Manchester City v Wolverhampton Wanderers matched to Man City v Wolves');
  const [text] = previewText(matches, cfg);
  assert.match(text, /📊 Stats model \(info only\): Manchester City \d+%/);
  assert.equal(matches.find((m) => m.event.id === 'evt_sinner').stats, null, 'tennis has no stats model');
});
