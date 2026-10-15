import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createPayouts, payoutConfigFromEnv, PayoutError } from '../src/payouts.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-15T12:00:00Z');
const daysFromNow = (d) => new Date(NOW + d * DAY).toISOString();

/** Stand-in for Stripe's host account API with a controllable balance. */
function fakeHostAccounts() {
  const calls = [];
  const accounts = { balance: { available: 0, instantAvailable: 0 }, failInstant: false, failFee: false };
  return {
    calls,
    accounts,
    payments: {
      name: 'stripe',
      requiresHostAccount: true,
      hostAccounts: {
        async balance() { return { ...accounts.balance }; },
        async payout(acct, opts) {
          if (opts.method === 'instant' && accounts.failInstant) throw new Error('external account not eligible');
          calls.push(['payout', acct, opts]);
          return { id: `po_${calls.length}`, arrivalDate: null };
        },
        async collectFee(acct, opts) {
          if (accounts.failFee) throw new Error('account debits not enabled');
          calls.push(['collectFee', acct, opts]);
          return 'py_1';
        },
        async returnFee(acct, opts) { calls.push(['returnFee', acct, opts]); return 'tr_1'; },
      },
    },
  };
}

let db;
let stripe;
let payouts;
let hostId;

function addHost(email = 'host@test.com', tier = 'auto') {
  return Number(db.prepare(`INSERT INTO users (name, email, password_hash, role, stripe_account_id, stripe_charges_enabled, payout_tier)
    VALUES ('Host', ?, 'x', 'host', 'acct_1', 1, ?)`).run(email, tier).lastInsertRowid);
}
let buyerId;
/** An event with one paid order earning `earnings` pence for the host (after commission). */
function addEvent(host, { startsAt, status = 'published', earnings = 1000, orderStatus = 'paid' }) {
  const eventId = Number(db.prepare("INSERT INTO events (host_id, title, venue, starts_at, status) VALUES (?, 'E', 'V', ?, ?)")
    .run(host, startsAt, status).lastInsertRowid);
  db.prepare(`INSERT INTO orders (user_id, event_id, subtotal_cents, commission_cents, total_cents, status)
    VALUES (?, ?, ?, 0, ?, ?)`).run(buyerId, eventId, earnings, earnings, orderStatus);
  return eventId;
}

beforeEach(() => {
  db = openDb();
  stripe = fakeHostAccounts();
  payouts = createPayouts({ db, payments: stripe.payments, now: () => NOW });
  buyerId = Number(db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('B', 'b@test.com', 'x', 'client')").run().lastInsertRowid);
  hostId = addHost();
});

const host = (id = hostId) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

test('new hosts: earnings are held until 2 days after the event', async () => {
  addEvent(hostId, { startsAt: daysFromNow(5), earnings: 3000 });   // upcoming: held
  addEvent(hostId, { startsAt: daysFromNow(-1), earnings: 2000 });  // happened yesterday: still held
  addEvent(hostId, { startsAt: daysFromNow(-3), earnings: 1500 });  // past the hold: payable
  assert.equal(payouts.isTrusted(host()), false);
  assert.equal(payouts.heldFor(host()), 5000);

  stripe.accounts.balance.available = 6500;
  const payout = await payouts.payOutHost(host());
  assert.ok(payout);
  const [, acct, opts] = stripe.calls[0];
  assert.equal(acct, 'acct_1');
  assert.equal(opts.amount, 1500);
  assert.equal(opts.method, 'standard');
  assert.equal(db.prepare('SELECT amount_cents FROM payouts').get().amount_cents, 1500);
});

test('nothing is paid out while recent sales are still clearing', async () => {
  addEvent(hostId, { startsAt: daysFromNow(5), earnings: 3000 });
  stripe.accounts.balance.available = 1000; // less than what is held
  assert.equal(await payouts.payOutHost(host()), null);
  assert.equal(stripe.calls.length, 0);
});

test('hosts become trusted after 3 completed events, unless they cancelled one with sales this year', () => {
  for (const d of [-30, -20, -10]) addEvent(hostId, { startsAt: daysFromNow(d) });
  assert.equal(payouts.isTrusted(host()), true);
  assert.equal(payouts.heldFor(host()), 0);

  addEvent(hostId, { startsAt: daysFromNow(-5), status: 'cancelled', orderStatus: 'refunded' });
  assert.equal(payouts.isTrusted(host()), false);
});

test('manual tiers override the automatic rule', () => {
  assert.equal(payouts.isTrusted(host()), false);
  payouts.setHostTier(hostId, 'trusted');
  assert.equal(payouts.isTrusted(host()), true);
  for (const d of [-30, -20, -10]) addEvent(hostId, { startsAt: daysFromNow(d) });
  payouts.setHostTier(hostId, 'standard');
  assert.equal(payouts.isTrusted(host()), false);
  assert.throws(() => payouts.setHostTier(hostId, 'vip'));
});

test('trusted hosts are paid everything available, once a day', async () => {
  payouts.setHostTier(hostId, 'trusted');
  addEvent(hostId, { startsAt: daysFromNow(5), earnings: 3000 });
  stripe.accounts.balance.available = 3000;
  await payouts.runDue();
  await payouts.runDue(); // same day: skipped
  const paid = stripe.calls.filter(([kind]) => kind === 'payout');
  assert.equal(paid.length, 1);
  assert.equal(paid[0][2].amount, 3000);
  assert.ok(host().last_payout_run_at);
});

test('instant payouts: only for trusted hosts; fee is collected from the host first', async () => {
  stripe.accounts.balance.instantAvailable = 10000;
  await assert.rejects(payouts.instant(hostId), PayoutError);

  payouts.setHostTier(hostId, 'trusted');
  const result = await payouts.instant(hostId);
  assert.deepEqual([result.amount, result.fee], [9900, 100]); // 1% of £100
  assert.deepEqual(stripe.calls.map(([kind]) => kind), ['collectFee', 'payout']);
  assert.equal(stripe.calls[0][2].amount, 100);
  assert.equal(stripe.calls[1][2].method, 'instant');
  assert.equal(stripe.calls[1][2].amount, 9900);
  const logged = db.prepare('SELECT * FROM payouts').get();
  assert.deepEqual([logged.method, logged.amount_cents, logged.fee_cents], ['instant', 9900, 100]);
});

test('instant payout fee has a 40p minimum, and small balances are refused', async () => {
  assert.equal(payouts.instantFeeFor(1000), 40);
  assert.equal(payouts.instantFeeFor(12345), 124);
  payouts.setHostTier(hostId, 'trusted');
  stripe.accounts.balance.instantAvailable = 120; // £1.20 - 40p fee leaves less than £1
  await assert.rejects(payouts.instant(hostId), /no money available/);
});

test('if the instant payout fails, the fee is returned', async () => {
  payouts.setHostTier(hostId, 'trusted');
  stripe.accounts.balance.instantAvailable = 5000;
  stripe.accounts.failInstant = true;
  await assert.rejects(payouts.instant(hostId), /can't receive instant payouts/);
  assert.deepEqual(stripe.calls.map(([kind]) => kind), ['collectFee', 'returnFee']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payouts').get().n, 0);
});

test('if the fee cannot be collected, no instant payout is made', async () => {
  payouts.setHostTier(hostId, 'trusted');
  stripe.accounts.balance.instantAvailable = 5000;
  stripe.accounts.failFee = true;
  await assert.rejects(payouts.instant(hostId), /unavailable right now/);
  assert.equal(stripe.calls.length, 0);
});

test('payout settings from environment', () => {
  assert.deepEqual(payoutConfigFromEnv({}), { holdDaysAfterEvent: 2, trustedMinEvents: 3, instantFeePercent: 1, instantMinFeePence: 40 });
  assert.equal(payoutConfigFromEnv({ PAYOUT_HOLD_DAYS_AFTER_EVENT: '7' }).holdDaysAfterEvent, 7);
  assert.throws(() => payoutConfigFromEnv({ TRUSTED_HOST_MIN_EVENTS: '2.5' }));
});

test('Payouts page shows held money for new hosts and the instant button for trusted ones', async () => {
  const payments = {
    ...stripe.payments,
    async startCheckout() { throw new Error('unused'); },
    hostAccounts: { ...stripe.payments.hostAccounts, async status() { return { chargesEnabled: true, detailsSubmitted: true }; } },
  };
  const app = createApp({ db, payments, sessionSecret: 'test' });
  const agent = request.agent(app);
  const page = await agent.get('/register');
  const _csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  await agent.post('/register').type('form').send({ _csrf, name: 'H', email: 'h2@test.com', password: 'password123', role: 'host' });
  const id = db.prepare("SELECT id FROM users WHERE email = 'h2@test.com'").get().id;
  db.prepare("UPDATE users SET stripe_account_id = 'acct_1', stripe_charges_enabled = 1 WHERE id = ?").run(id);
  addEvent(id, { startsAt: new Date(Date.now() + 5 * DAY).toISOString(), earnings: 4200 });
  stripe.accounts.balance = { available: 0, instantAvailable: 0 };

  let res = await agent.get('/host/payments');
  assert.match(res.text, /2 days after the event/);
  assert.match(res.text, /Held until after events[\s\S]*£42\.00/);
  assert.doesNotMatch(res.text, /Get paid now/);

  db.prepare("UPDATE users SET payout_tier = 'trusted' WHERE id = ?").run(id);
  stripe.accounts.balance = { available: 4200, instantAvailable: 4200 };
  res = await agent.get('/host/payments');
  assert.match(res.text, /Trusted host/);
  assert.match(res.text, /Get paid now: £41\.58/);

  const token = res.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const sent = await agent.post('/host/payments/instant').type('form').send({ _csrf: token });
  const after = await agent.get(sent.headers.location);
  assert.match(after.text, /Instant payout of £41\.58 sent \(fee 42p\)|Instant payout of £41\.58 sent \(fee £0\.42\)/);
});
