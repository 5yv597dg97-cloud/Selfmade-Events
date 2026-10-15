import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedValue, kellyFraction, stake, logGrowth } from '../src/kelly.js';

test('EV and Kelly', () => {
  assert.ok(Math.abs(expectedValue(0.55, 2) - 0.1) < 1e-12);
  assert.ok(Math.abs(kellyFraction(0.55, 2) - 0.1) < 1e-12);
  assert.equal(kellyFraction(0.4, 2), 0);
});

test('stake applies the Kelly fraction and the cap', () => {
  const s = stake({ p: 0.55, odds: 2, bankroll: 1000, fraction: 0.25, maxStakePct: 0.05 });
  assert.ok(Math.abs(s.f - 0.025) < 1e-12);
  assert.equal(s.amount, 25);
  assert.equal(stake({ p: 0.7, odds: 2, bankroll: 1000, fraction: 1, maxStakePct: 0.02 }).amount, 20);
});

test('log growth is positive for a fractional Kelly bet with an edge', () => {
  assert.ok(logGrowth(0.55, 2, 0.025) > 0);
  assert.ok(logGrowth(0.45, 2, 0.025) < 0);
});
