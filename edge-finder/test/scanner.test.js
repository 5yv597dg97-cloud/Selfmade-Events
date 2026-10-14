import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { scan, marketLines, currentFairProb } from '../src/scanner.js';

const events = JSON.parse(readFileSync(new URL('../fixtures/sample-odds.json', import.meta.url)));
const NOW = Date.parse('2026-10-14T12:00:00Z');
const cfg = (flags = {}) => loadConfig({}, { profile: 'value', ...flags });

test('finds the value bets in the sample and ranks the clean ones first', () => {
  const picks = scan(events, cfg(), NOW);
  assert.deepEqual(picks.map((p) => [p.eventId, p.outcome, p.book]), [
    ['evt_ufc2', 'Tom Aspinall', 'paddypower'],
    ['evt_ufc1', 'Islam Makhachev', 'betfair_sb_uk'],
    ['evt_ars_eve', 'Arsenal', 'williamhill'],
    ['evt_bos_nyk', 'Boston Celtics', 'skybet'],
    ['evt_swiatek', 'Iga Swiatek', 'betfair_sb_uk'],
    ['evt_kc_lv', 'Kansas City Chiefs', 'coral'],
  ]);
  for (const p of picks) {
    assert.ok(p.ev >= 0.02 && p.fairProb >= 0.4);
    assert.ok(Math.abs(p.ev - (p.fairProb * p.odds - 1)) < 1e-12);
  }
  const [, , ars, , , kc] = picks;
  assert.equal(ars.fairSource, 'pinnacle+betfair_ex_uk');
  assert.ok(ars.stake > 0 && ars.stake <= 20);
  assert.equal(kc.suspicious, true);
  assert.equal(kc.stake, 0);
});

test('skips stale prices, started events and events with no sharp price', () => {
  const picks = scan(events, cfg({ 'one-per-event': false, 'max-edge': 1 }), NOW);
  assert.ok(!picks.some((p) => p.book === 'ladbrokes_uk'));
  assert.ok(!picks.some((p) => p.eventId === 'evt_live' || p.eventId === 'evt_no_sharp'));
});

test('with one-per-event off, a second bet on the same match shows up', () => {
  const picks = scan(events, cfg({ 'one-per-event': false }), NOW);
  const nba = picks.filter((p) => p.eventId === 'evt_bos_nyk');
  assert.deepEqual(nba.map((p) => p.market).sort(), ['h2h', 'spreads']);
});

test('the safe profile only takes 75%+ outcomes at my books', () => {
  const safe = loadConfig({}, {});
  assert.equal(safe.profile, 'safe');
  const picks = scan(events, safe, NOW);
  assert.deepEqual(picks.map((p) => [p.outcome, p.book]), [
    ['Jannik Sinner', 'paddypower'],
    ['Islam Makhachev', 'betfair_sb_uk'],
    ['Liverpool', 'paddypower'],
  ]);
  for (const p of picks) {
    assert.ok(p.fairProb >= 0.75 && p.odds <= 1.4 && p.ev >= 0.015);
    assert.ok(p.stake <= 5);
  }
  // Swiatek has an edge but only a 72% chance, so it's left out.
  assert.ok(!picks.some((p) => p.eventId === 'evt_swiatek'));
});

test('settings override the profile, and unknown profiles are rejected', () => {
  assert.equal(loadConfig({ EDGE_MIN_PROB: '0.8' }, {}).minProb, 0.8);
  assert.equal(loadConfig({ EDGE_PROFILE: 'value' }, {}).minProb, 0.4);
  assert.throws(() => loadConfig({}, { profile: 'yolo' }));
});

test('restricting to my books and raising the probability floor', () => {
  assert.deepEqual(scan(events, cfg({ books: 'paddypower' }), NOW).map((p) => p.outcome), ['Tom Aspinall']);
  const strict = scan(events, cfg({ 'min-prob': 0.65 }), NOW);
  assert.ok(strict.every((p) => p.fairProb >= 0.65));
  assert.ok(strict.length >= 1);
});

test('consensus mode prices a match with no sharp book when enough books quote it', () => {
  const picks = scan(events, cfg({ consensus: true, 'min-consensus-books': 4 }), NOW);
  assert.ok(picks.some((p) => p.eventId === 'evt_no_sharp' && p.fairSource === 'consensus of 4'));
});

test('spread lines line up across books by the home handicap', () => {
  const event = { home_team: 'H', away_team: 'A' };
  const lines = marketLines({ key: 'spreads', outcomes: [
    { name: 'H', point: -1.5, price: 2 }, { name: 'A', point: 1.5, price: 1.8 },
    { name: 'H', point: -2.5, price: 2.6 }, { name: 'A', point: 2.5, price: 1.5 },
  ] }, event);
  assert.deepEqual([...lines.keys()], ['-1.5', '-2.5']);
  assert.equal(lines.get('-1.5').length, 2);
});

test('current fair probability for a logged bet', () => {
  const bet = { event_id: 'evt_ars_eve', market: 'h2h', line: 'h2h', outcome: 'Arsenal' };
  const p = currentFairProb(events, bet, cfg(), NOW);
  assert.ok(p > 0.6 && p < 0.7);
  assert.equal(currentFairProb(events, { ...bet, event_id: 'nope' }, cfg(), NOW), null);
});
