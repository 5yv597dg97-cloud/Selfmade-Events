import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { findDoubles, fractional } from '../src/doubles.js';

const events = JSON.parse(readFileSync(new URL('../fixtures/sample-odds.json', import.meta.url)));
const NOW = Date.parse('2026-10-14T12:00:00Z');

test('pairs value legs at the same bookmaker into a 50/1–150/1 double', () => {
  const [d, ...rest] = findDoubles(events, loadConfig({}, {}), NOW);
  assert.equal(rest.length, 0);
  assert.equal(d.book, 'paddypower');
  assert.deepEqual(d.legs.map((l) => l.outcome), ['Arthur Fils', 'Wolverhampton Wanderers']);
  assert.equal(d.odds, 66.3);
  assert.ok(Math.abs(d.fairProb - d.legs[0].fairProb * d.legs[1].fairProb) < 1e-12);
  assert.ok(d.ev >= 0.05 && Math.abs(d.ev - (d.fairProb * d.odds - 1)) < 1e-12);
  assert.equal(d.stake, 0.2);
  assert.ok(d.minPrice <= d.odds && d.minPrice * d.fairProb >= 1.02);
});

test('respects the odds range and the edge needed', () => {
  assert.deepEqual(findDoubles(events, loadConfig({}, { 'double-max-odds': 60 }), NOW), []);
  assert.deepEqual(findDoubles(events, loadConfig({}, { 'double-min-edge': 0.2 }), NOW), []);
  assert.deepEqual(findDoubles(events, loadConfig({}, { books: 'coral' }), NOW), []);
});

test('fractional odds', () => {
  assert.equal(fractional(100), '99/1');
  assert.equal(fractional(66.3), '65/1');
});
