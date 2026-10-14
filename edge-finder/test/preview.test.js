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
