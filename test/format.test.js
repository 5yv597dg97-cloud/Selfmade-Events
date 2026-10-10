import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money, dateTime, parseCents, parseInputDateTime, toInputDateTime } from '../src/format.js';

test('money is shown in pounds', () => {
  assert.equal(money(1250), '£12.50');
  assert.equal(money(123456), '£1,234.56');
  assert.equal(money(0), 'Free');
  assert.equal(money(0, { free: false }), '£0.00');
});

test('parseCents accepts pounds with or without the £ sign', () => {
  assert.equal(parseCents('12.5'), 1250);
  assert.equal(parseCents('£20'), 2000);
  assert.ok(Number.isNaN(parseCents('-1')));
  assert.ok(Number.isNaN(parseCents('12.345')));
});

test('form times are UK time in both GMT and BST', () => {
  // Winter (GMT, UTC+0) and summer (BST, UTC+1).
  assert.equal(parseInputDateTime('2026-12-01T19:00').toISOString(), '2026-12-01T19:00:00.000Z');
  assert.equal(parseInputDateTime('2026-07-01T19:00').toISOString(), '2026-07-01T18:00:00.000Z');
  assert.equal(toInputDateTime('2026-07-01T18:00:00.000Z'), '2026-07-01T19:00');
  assert.equal(toInputDateTime('2026-12-01T19:00:00.000Z'), '2026-12-01T19:00');
  assert.ok(Number.isNaN(parseInputDateTime('nonsense').getTime()));
});

test('dates display in UK format and time', () => {
  assert.equal(dateTime('2026-07-01T18:00:00.000Z'), 'Wed, 1 Jul 2026, 7:00 pm');
});
