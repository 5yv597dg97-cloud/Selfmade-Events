// End-to-end checkout flow with a hosted (redirect) payment provider, using an
// in-memory stand-in for Stripe so no network or credentials are needed.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

function fakeStripe() {
  let n = 0;
  const sessions = new Map();
  const accounts = new Map();
  return {
    name: 'stripe',
    requiresHostAccount: true,
    sessions,
    accounts,
    refunds: [],
    failStart: false,
    async startCheckout(opts) {
      if (this.failStart) throw new Error('Stripe is down');
      const id = `cs_test_${++n}`;
      sessions.set(id, { id, status: 'open', paid: false, pi: `pi_test_${n}`, opts });
      return { status: 'redirect', url: `https://checkout.stripe.test/${id}`, sessionId: id };
    },
    async getCheckout(id) {
      const s = sessions.get(id);
      return { paid: s.paid, open: s.status === 'open', reference: s.pi };
    },
    async expireCheckout(id) {
      const s = sessions.get(id);
      if (s.status === 'open') s.status = 'expired';
    },
    async refund(args) {
      this.refunds.push(args);
      return { ok: true };
    },
    parseWebhook(raw, signature) {
      if (signature !== 'valid') throw new Error('No signatures found matching the expected signature');
      return JSON.parse(raw.toString());
    },
    hostAccounts: {
      async create() {
        const id = `acct_test_${accounts.size + 1}`;
        accounts.set(id, { chargesEnabled: false, detailsSubmitted: false });
        return id;
      },
      async onboardingUrl(id, { returnUrl }) {
        return `https://connect.stripe.test/onboard/${id}?return=${encodeURIComponent(returnUrl)}`;
      },
      async status(id) {
        return accounts.get(id);
      },
      async dashboardUrl(id) {
        return `https://connect.stripe.test/dashboard/${id}`;
      },
    },
    /** Simulate the buyer paying on the Stripe page. */
    pay(id) {
      Object.assign(sessions.get(id), { status: 'complete', paid: true });
    },
  };
}

const FEES = { bookingFeePercent: 5, bookingFeeFixedPence: 30, commissionPercent: 10 };

let db;
let app;
let stripe;

beforeEach(() => {
  db = openDb();
  stripe = fakeStripe();
  app = createApp({ db, payments: stripe, fees: FEES, sessionSecret: 'test' });
});

async function csrfFrom(agent, path) {
  const res = await agent.get(path);
  const m = res.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(m, `no csrf token on ${path} (status ${res.status})`);
  return m[1];
}

async function signUp(role, email = `${role}@test.com`) {
  const agent = request.agent(app);
  const _csrf = await csrfFrom(agent, '/register');
  await agent.post('/register').type('form').send({ _csrf, name: role, email, password: 'password123', role });
  return agent;
}

function futureLocal(days = 10) {
  const d = new Date(Date.now() + days * 864e5);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T19:00`;
}

async function connectPayouts(host) {
  const _csrf = await csrfFrom(host, '/host/payments');
  const res = await host.post('/host/payments/connect').type('form').send({ _csrf });
  assert.equal(res.status, 303);
  assert.match(res.headers.location, /^https:\/\/connect\.stripe\.test\/onboard\/acct_test_1/);
  stripe.accounts.get('acct_test_1').chargesEnabled = true; // host completes Stripe onboarding
  const back = await host.get('/host/payments/return');
  assert.equal(back.headers.location, '/host/payments');
}

async function createEvent(host, { price = '20', capacity = '5', publish = '1' } = {}) {
  const _csrf = await csrfFrom(host, '/host/events/new');
  const res = await host.post('/host/events').type('form').send({
    _csrf, title: 'Gig', venue: 'Hall', starts_at: futureLocal(), publish,
    'types[0][name]': 'GA', 'types[0][price]': price, 'types[0][capacity]': capacity,
  });
  const event = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
  const type = db.prepare('SELECT * FROM ticket_types WHERE event_id = ?').get(event.id);
  return { res, event, type };
}

async function startCheckout(agent, event, type, qty) {
  const _csrf = await csrfFrom(agent, `/events/${event.id}`);
  return agent.post(`/events/${event.id}/checkout`).type('form').send({ _csrf, [`qty_${type.id}`]: String(qty) });
}

function webhook(type, session) {
  return request(app).post('/stripe/webhook')
    .set('Content-Type', 'application/json').set('Stripe-Signature', 'valid')
    .send(JSON.stringify({ id: 'evt_1', type, data: { object: session } }));
}

const sold = (typeId) => db.prepare('SELECT sold FROM ticket_types WHERE id = ?').get(typeId).sold;
const order = () => db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();

test('a host cannot publish paid events until payouts are set up', async () => {
  const host = await signUp('host');
  const { res, event } = await createEvent(host);
  assert.equal(res.headers.location, '/host/payments');
  assert.equal(event.status, 'draft');

  await connectPayouts(host);
  const _csrf = await csrfFrom(host, '/host');
  await host.post(`/host/events/${event.id}/publish`).type('form').send({ _csrf });
  assert.equal(db.prepare('SELECT status FROM events WHERE id = ?').get(event.id).status, 'published');
});

test('free events can be published and booked without payouts or Stripe', async () => {
  const host = await signUp('host');
  const { event, type } = await createEvent(host, { price: '0' });
  assert.equal(event.status, 'published');
  const client = await signUp('client');
  const res = await startCheckout(client, event, type, 2);
  assert.match(res.headers.location, /^\/my-tickets/);
  assert.equal(order().status, 'paid');
  assert.equal(order().total_cents, 0);
  assert.equal(stripe.sessions.size, 0);
});

test('paid checkout: buyer is sent to Stripe with fees and the host as payout destination', async () => {
  const host = await signUp('host');
  await connectPayouts(host);
  const { event, type } = await createEvent(host);
  const client = await signUp('client');

  const res = await startCheckout(client, event, type, 2);
  assert.equal(res.status, 303);
  assert.match(res.headers.location, /^https:\/\/checkout\.stripe\.test\/cs_test_1$/);

  const o = order();
  assert.equal(o.status, 'pending');
  assert.equal(o.checkout_session_id, 'cs_test_1');
  // 2 x £20 tickets; booking fee per ticket = 5% of £20 + 30p = £1.30; commission 10% of £40.
  assert.equal(o.subtotal_cents, 4000);
  assert.equal(o.booking_fee_cents, 260);
  assert.equal(o.total_cents, 4260);
  assert.equal(o.commission_cents, 400);
  assert.equal(sold(type.id), 2, 'seats are held during checkout');

  const { opts } = stripe.sessions.get('cs_test_1');
  assert.equal(opts.hostAccountId, 'acct_test_1');
  assert.equal(opts.pricing.applicationFee, 660);
  assert.equal(opts.buyerEmail, 'client@test.com');
  assert.match(opts.successUrl, /\/orders\/\d+\/success$/);
  assert.match(opts.cancelUrl, /\/orders\/\d+\/cancel$/);
});

test('webhook confirms payment; tickets appear and host earnings exclude commission', async () => {
  const host = await signUp('host');
  await connectPayouts(host);
  const { event, type } = await createEvent(host);
  const client = await signUp('client');
  await startCheckout(client, event, type, 2);
  stripe.pay('cs_test_1');

  const res = await webhook('checkout.session.completed', {
    id: 'cs_test_1', payment_status: 'paid', payment_intent: 'pi_test_1', metadata: { order_id: String(order().id) },
  });
  assert.equal(res.status, 200);
  assert.equal(order().status, 'paid');
  assert.equal(order().payment_reference, 'pi_test_1');

  // Webhook retries are harmless.
  await webhook('checkout.session.completed', {
    id: 'cs_test_1', payment_status: 'paid', payment_intent: 'pi_test_1', metadata: { order_id: String(order().id) },
  });
  assert.equal(order().status, 'paid');

  const page = await client.get('/my-tickets');
  assert.match(page.text, /£42\.60/);
  assert.match(page.text, /£2\.60 booking fee/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 2);

  const dash = await host.get('/host');
  assert.match(dash.text, /£36\.00/); // £40 sales - £4 commission
});

test('returning to the success page confirms payment even before the webhook arrives', async () => {
  const host = await signUp('host');
  await connectPayouts(host);
  const { event, type } = await createEvent(host);
  const client = await signUp('client');
  await startCheckout(client, event, type, 1);
  stripe.pay('cs_test_1');

  const res = await client.get(`/orders/${order().id}/success?session_id=cs_test_1`);
  assert.match(res.headers.location, /^\/my-tickets/);
  assert.equal(order().status, 'paid');
});

test('cancelling on the Stripe page frees the seats immediately', async () => {
  const host = await signUp('host');
  await connectPayouts(host);
  const { event, type } = await createEvent(host);
  const client = await signUp('client');
  await startCheckout(client, event, type, 3);
  assert.equal(sold(type.id), 3);

  const res = await client.get(`/orders/${order().id}/cancel`);
  assert.equal(res.headers.location, `/events/${event.id}`);
  assert.equal(order().status, 'failed');
  assert.equal(sold(type.id), 0);
  assert.equal(stripe.sessions.get('cs_test_1').status, 'expired');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 0);
});

test('expired checkouts release seats (webhook), and buyers cannot touch other orders', async () => {
  const host = await signUp('host');
  await connectPayouts(host);
  const { event, type } = await createEvent(host);
  const client = await signUp('client');
  await startCheckout(client, event, type, 2);

  const other = await signUp('client', 'other@test.com');
  assert.equal((await other.get(`/orders/${order().id}/cancel`)).status, 404);

  await webhook('checkout.session.expired', { id: 'cs_test_1', payment_status: 'unpaid', metadata: { order_id: String(order().id) } });
  assert.equal(order().status, 'failed');
  assert.equal(sold(type.id), 0);
});

test('webhooks with a bad signature or unknown session are rejected or ignored', async () => {
  const bad = await request(app).post('/stripe/webhook').set('Content-Type', 'application/json')
    .set('Stripe-Signature', 'forged').send('{}');
  assert.equal(bad.status, 400);

  const host = await signUp('host');
  await connectPayouts(host);
  const { event, type } = await createEvent(host);
  const client = await signUp('client');
  await startCheckout(client, event, type, 1);
  const res = await webhook('checkout.session.completed', {
    id: 'cs_someone_else', payment_status: 'paid', payment_intent: 'pi_x', metadata: { order_id: String(order().id) },
  });
  assert.equal(res.status, 200);
  assert.equal(order().status, 'pending');
});

test('a payment that lands after the hold was released is refunded automatically', async () => {
  const host = await signUp('host');
  await connectPayouts(host);
  const { event, type } = await createEvent(host);
  const client = await signUp('client');
  await startCheckout(client, event, type, 1);
  const id = order().id;
  await webhook('checkout.session.expired', { id: 'cs_test_1', metadata: { order_id: String(id) } });
  assert.equal(order().status, 'failed');

  await webhook('checkout.session.completed', { id: 'cs_test_1', payment_status: 'paid', payment_intent: 'pi_test_1', metadata: { order_id: String(id) } });
  assert.equal(order().status, 'refunded');
  assert.deepEqual(stripe.refunds.map((r) => r.reference), ['pi_test_1']);
  assert.equal(sold(type.id), 0);
});

test('the background sweep settles stale checkouts whose webhooks never arrived', async () => {
  const host = await signUp('host');
  await connectPayouts(host);
  const { event, type } = await createEvent(host);
  const a = await signUp('client', 'a@test.com');
  const b = await signUp('client', 'b@test.com');
  await startCheckout(a, event, type, 1); // will be paid
  await startCheckout(b, event, type, 1); // will expire
  stripe.pay('cs_test_1');
  stripe.sessions.get('cs_test_2').status = 'expired';
  db.prepare("UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z'").run();

  // Reach the sweep through a fresh app instance sharing the database.
  const { createOrders } = await import('../src/orders.js');
  await createOrders({ db, payments: stripe }).sweep();

  const statuses = db.prepare('SELECT checkout_session_id, status FROM orders ORDER BY id').all().map((r) => r.status);
  assert.deepEqual(statuses, ['paid', 'failed']);
  assert.equal(sold(type.id), 1);
});

test('if Stripe is unavailable, the seats are released and the buyer is told', async () => {
  const host = await signUp('host');
  await connectPayouts(host);
  const { event, type } = await createEvent(host);
  const client = await signUp('client');
  stripe.failStart = true;
  const res = await startCheckout(client, event, type, 2);
  assert.equal(res.headers.location, `/events/${event.id}`);
  assert.equal(sold(type.id), 0);
  assert.equal(order().status, 'failed');
});

test('cancelling an event refunds paid orders through Stripe', async () => {
  const host = await signUp('host');
  await connectPayouts(host);
  const { event, type } = await createEvent(host);
  const client = await signUp('client');
  await startCheckout(client, event, type, 1);
  stripe.pay('cs_test_1');
  await client.get(`/orders/${order().id}/success?session_id=cs_test_1`);

  const _csrf = await csrfFrom(host, '/host');
  await host.post(`/host/events/${event.id}/cancel`).type('form').send({ _csrf });
  assert.equal(order().status, 'refunded');
  assert.deepEqual(stripe.refunds, [{ reference: 'pi_test_1', amountCents: 2130 }]);
});

test('ticket page shows booking fees and blocks sales until the host can take payments', async () => {
  const host = await signUp('host');
  await connectPayouts(host);
  const { event } = await createEvent(host);
  const page = await request(app).get(`/events/${event.id}`);
  assert.match(page.text, /£20\.00 \+ £1\.30 fee/);

  // Host's Stripe account becomes restricted.
  db.prepare('UPDATE users SET stripe_charges_enabled = 0').run();
  stripe.accounts.get('acct_test_1').chargesEnabled = false;
  const blocked = await request(app).get(`/events/${event.id}`);
  assert.match(blocked.text, /once the host has finished setting up payments/);
});
