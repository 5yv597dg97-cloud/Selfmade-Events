import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devig, overround, METHODS } from '../src/devig.js';

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

test('every method returns probabilities summing to 1', () => {
  for (const method of Object.keys(METHODS)) {
    for (const odds of [[1.95, 1.95], [1.45, 4.6, 8.0], [1.1, 7.5], [3.2, 3.3, 2.4]]) {
      const p = devig(odds, method);
      assert.ok(Math.abs(sum(p) - 1) < 1e-9, `${method} ${odds}`);
    }
  }
});

test('even market devigs to 50/50', () => {
  for (const method of Object.keys(METHODS)) assert.deepEqual(devig([1.9, 1.9], method).map((x) => x.toFixed(6)), ['0.500000', '0.500000']);
});

test('power and shin take more margin from the longshot than multiplicative', () => {
  const odds = [1.25, 4.5];
  const mult = devig(odds, 'multiplicative');
  for (const method of ['power', 'shin']) {
    const p = devig(odds, method);
    assert.ok(p[1] < mult[1], method);
    assert.ok(p[0] > mult[0], method);
  }
});

test('overround and bad input', () => {
  assert.ok(Math.abs(overround([1.9, 1.9]) - 0.0526) < 1e-3);
  assert.throws(() => devig([1.5]));
  assert.throws(() => devig([1, 2]));
  assert.throws(() => devig([2, 2], 'nope'));
});
