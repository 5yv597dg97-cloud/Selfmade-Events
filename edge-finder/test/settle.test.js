import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grade, manualResult } from '../src/settle.js';
import { report } from '../src/store.js';

const bet = (o) => ({ home: 'H', away: 'A', odds: 2, stake: 10, ...o });

test('match result, including the draw', () => {
  assert.deepEqual(grade(bet({ market: 'h2h', outcome: 'H' }), 2, 1), { status: 'won', pnl: 10 });
  assert.deepEqual(grade(bet({ market: 'h2h', outcome: 'H' }), 1, 1), { status: 'lost', pnl: -10 });
  assert.deepEqual(grade(bet({ market: 'h2h', outcome: 'Draw' }), 1, 1), { status: 'won', pnl: 10 });
  assert.deepEqual(grade(bet({ market: 'h2h', outcome: 'A' }), 0, 3), { status: 'won', pnl: 10 });
});

test('totals and spreads, with pushes', () => {
  assert.equal(grade(bet({ market: 'totals', outcome: 'Over', point: 2.5 }), 2, 1).status, 'won');
  assert.equal(grade(bet({ market: 'totals', outcome: 'Under', point: 3 }), 2, 1).status, 'push');
  assert.equal(grade(bet({ market: 'spreads', outcome: 'H', point: -4.5 }), 100, 96).status, 'lost');
  assert.equal(grade(bet({ market: 'spreads', outcome: 'A', point: 4.5 }), 100, 96).status, 'won');
});

test('quarter lines split the stake', () => {
  // H -0.25 and a draw: half on 0 pushes, half on -0.5 loses.
  assert.deepEqual(grade(bet({ market: 'spreads', outcome: 'H', point: -0.25 }), 1, 1), { status: 'half-lost', pnl: -5 });
  // Over 2.75 with 3 goals: half on 2.5 wins, half on 3 pushes.
  assert.deepEqual(grade(bet({ market: 'totals', outcome: 'Over', point: 2.75 }), 2, 1), { status: 'half-won', pnl: 5 });
});

test('manual results', () => {
  assert.deepEqual(manualResult(bet({}), 'void'), { status: 'void', pnl: 0 });
  assert.throws(() => manualResult(bet({}), 'maybe'));
});

test('report computes ROI and closing line value', () => {
  const r = report([
    { status: 'won', stake: 10, pnl: 10, ev: 0.05, odds: 2, close_prob: 0.55 },
    { status: 'lost', stake: 10, pnl: -10, ev: 0.03, odds: 2, close_prob: 0.45 },
    { status: 'open', stake: 10, pnl: null, ev: 0.04, odds: 2, close_prob: null },
  ]);
  assert.equal(r.settled, 2);
  assert.equal(r.roi, 0);
  assert.ok(Math.abs(r.avgClv - 0) < 1e-12);
  assert.equal(r.beatClose, 0.5);
  assert.ok(Math.abs(r.expectedPnl - 0.8) < 1e-12);
});
