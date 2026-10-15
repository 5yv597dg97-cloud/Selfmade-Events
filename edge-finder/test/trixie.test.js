import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { findTrixies, trixieStats, trixieOutcome, trixieReturn } from '../src/trixie.js';

const events = JSON.parse(readFileSync(new URL('../fixtures/sample-odds.json', import.meta.url)));
const NOW = Date.parse('2026-10-14T12:00:00Z');
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

test('chances and returns for three 80% legs at fair odds', () => {
  const s = trixieStats([0.8, 0.8, 0.8].map((p) => ({ fairProb: p, odds: 1 / p })));
  close(s.pAll, 0.512);
  close(s.pTwo, 0.384);
  close(s.pNothing, 0.104);
  close(s.ev, 0, 1e-12); // fair legs make a fair trixie
  close(s.returnAll, 3 * 1.5625 + 1.953125);
});

test('value legs make a value trixie', () => {
  const s = trixieStats([{ fairProb: 0.8, odds: 1.3 }, { fairProb: 0.8, odds: 1.3 }, { fairProb: 0.8, odds: 1.3 }]);
  // Each leg +4%: each double +8.16%, the treble +12.49%.
  close(s.ev, (3 * 1.04 ** 2 + 1.04 ** 3) / 4 - 1);
});

test('finds the Paddy Power trixie in the sample', () => {
  const [t, ...rest] = findTrixies(events, loadConfig({}, {}), NOW);
  assert.equal(rest.length, 0);
  assert.equal(t.book, 'paddypower');
  assert.deepEqual(t.legs.map((l) => l.outcome), ['Jannik Sinner', 'Liverpool', 'Islam Makhachev']);
  assert.ok(t.legs.every((l) => l.fairProb >= 0.75 && l.odds * l.fairProb >= 1));
  assert.ok(t.ev >= 0.02);
  assert.equal(t.stake, 2);
  assert.ok(t.pAll + t.pTwo > 0.85, 'pays something most of the time');
  assert.deepEqual(findTrixies(events, loadConfig({}, { 'trixie-min-edge': 0.2 }), NOW), []);
});

test('settling a trixie', () => {
  const legs = (r) => r.map((result, i) => ({ odds: [1.2, 1.3, 1.5][i], result }));
  const stake = 2; // £0.50 a line
  assert.equal(trixieOutcome({ stake, legs: legs(['won', null, null]) }), null);
  assert.deepEqual(trixieOutcome({ stake, legs: legs(['lost', 'lost', null]) }), { status: 'lost', pnl: -2 });
  const all = trixieOutcome({ stake, legs: legs(['won', 'won', 'won']) });
  close(all.pnl, Math.round((0.5 * trixieReturn([1.2, 1.3, 1.5]) - 2) * 100) / 100);
  assert.equal(all.status, 'won');
  assert.deepEqual(trixieOutcome({ stake, legs: legs(['won', 'won', 'lost']) }), { status: 'part', pnl: -1.22 });
  assert.equal(trixieOutcome({ stake, legs: legs(['won', 'lost', 'void']) }).status, 'part'); // the 1.2 double pays as a single
});
