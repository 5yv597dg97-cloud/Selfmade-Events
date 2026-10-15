// Featured listings: hosts pay per day to show an event first on the homepage.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { mockPayments } from '../src/payments.js';
import { NO_FEES } from '../src/fees.js';
import { createPromotions } from '../src/promotions.js';

const FEES = { ...NO_FEES, featuredDayPence: 200 };

/** A redirect-style provider standing in for Stripe's platform checkout. */
function fakeStripe() {
  let n = 0;
  return {
    ...mockPayments,
    name: 'stripe',
    sessions: new Map(),
    refunds: [],
    failStart: false,
    async startPlatformCheckout(opts) {
      if (this.failStart) throw new Error('Stripe is down');
      const id = `cs_test_${++n}`;
      this.sessions.set(id, { id, status: 'open', paid: false, pi: `pi_test_${n}`, opts });
      return { status: 'redirect', url: `https://checkout.stripe.test/${id}`, sessionId: id };
    },
    async getCheckout(id) {
      const s = this.sessions.get(id);
      return { paid: s.paid, open: s.status === 'open', reference: s.pi };
    },
    async expireCheckout(id) {
      const s = this.sessions.get(id);
      if (s.status === 'open') s.status = 'expired';
    },
    async refundPlatformCharge(args) {
      this.refunds.push(args);
      return { ok: true };
    },
    parseWebhook(raw, signature) {
      if (signature !== 'valid') throw new Error('bad signature');
      return JSON.parse(raw.toString());
    },
    pay(id) {
      Object.assign(this.sessions.get(id), { status: 'complete', paid: true });
    },
  };
}

let db;
let app;
let payments;

function start({ provider = mockPayments, fees = FEES } = {}) {
  db = openDb();
  payments = provider;
  app = createApp({ db, payments, fees, sessionSecret: 'test' });
}

beforeEach(() => start());

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

async function createEvent(host, { title = 'Gig', days = 10, publish = '1' } = {}) {
  const _csrf = await csrfFrom(host, '/host/events/new');
  await host.post('/host/events').type('form').send({
    _csrf, title, venue: 'Hall', starts_at: futureLocal(days), publish,
    'types[0][name]': 'GA', 'types[0][price]': '0', 'types[0][capacity]': '50',
  });
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
}

async function feature(host, event, days) {
  const _csrf = await csrfFrom(host, `/host/events/${event.id}/feature`);
  return host.post(`/host/events/${event.id}/feature`).type('form').send({ _csrf, days: String(days) });
}

function webhook(type, session) {
  return request(app).post('/stripe/webhook')
    .set('Content-Type', 'application/json').set('Stripe-Signature', 'valid')
    .send(JSON.stringify({ id: 'evt_1', type, data: { object: session } }));
}

const promotion = () => db.prepare('SELECT * FROM promotions ORDER BY id DESC LIMIT 1').get();
const days = (from, to) => (new Date(to) - new Date(from)) / 864e5;

test('a host features an event; it is shown first on the homepage', async () => {
  const host = await signUp('host');
  await createEvent(host, { title: 'Early Gig', days: 5 });
  const event = await createEvent(host, { title: 'Big Night', days: 9 });

  const page = await host.get(`/host/events/${event.id}/feature`);
  assert.match(page.text, /£2\.00 a day/);
  assert.match(page.text, /£14\.00/); // 7 days

  const res = await feature(host, event, 3);
  assert.equal(res.headers.location, '/host');
  const p = promotion();
  assert.equal(p.status, 'paid');
  assert.equal(p.amount_cents, 600);
  assert.ok(Math.abs(days(p.starts_at, p.ends_at) - 3) < 1e-9);

  const home = await request(app).get('/');
  const featuredAt = home.text.indexOf('Big Night');
  assert.match(home.text, /Featured/);
  assert.ok(featuredAt < home.text.indexOf('Early Gig'), 'featured event is listed before earlier events');
  assert.equal(home.text.split('Big Night').length - 1, 1, 'featured event is not listed twice');

  const dash = await host.get('/host');
  assert.match(dash.text, /badge-featured/);
  assert.match(dash.text, /Extend feature/);
});

test('buying more days extends the current featured period', async () => {
  const host = await signUp('host');
  const event = await createEvent(host, { days: 20 });
  await feature(host, event, 3);
  const first = promotion();
  await feature(host, event, 7);
  const second = promotion();
  assert.equal(second.starts_at, first.ends_at);
  assert.ok(Math.abs(days(first.starts_at, second.ends_at) - 10) < 1e-9);
});

test('featuring is limited to days before the event starts, and to the host\'s own live events', async () => {
  const host = await signUp('host');
  const event = await createEvent(host, { days: 10 });
  const tooLong = await feature(host, event, 14);
  assert.equal(tooLong.headers.location, `/host/events/${event.id}/feature`);
  const odd = await feature(host, event, 2);
  assert.equal(odd.headers.location, `/host/events/${event.id}/feature`);
  assert.equal(promotion(), undefined);

  const draft = await createEvent(host, { publish: '0' });
  assert.equal((await host.get(`/host/events/${draft.id}/feature`)).headers.location, '/host');

  const other = await signUp('host', 'other@test.com');
  assert.equal((await other.get(`/host/events/${event.id}/feature`)).status, 404);
});

test('featuring can be switched off', async () => {
  start({ fees: NO_FEES });
  const host = await signUp('host');
  const event = await createEvent(host);
  assert.equal((await host.get(`/host/events/${event.id}/feature`)).status, 404);
  assert.doesNotMatch((await host.get('/host')).text, /\/feature"/);
});

test('with Stripe: the host pays the platform, and the webhook starts the featured period', async () => {
  start({ provider: fakeStripe() });
  const host = await signUp('host');
  const event = await createEvent(host);

  const res = await feature(host, event, 7);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, 'https://checkout.stripe.test/cs_test_1');
  const { opts } = payments.sessions.get('cs_test_1');
  assert.equal(opts.amountCents, 1400);
  assert.equal(opts.buyerEmail, 'host@test.com');
  assert.equal(opts.metadata.promotion_id, String(promotion().id));
  assert.match(opts.successUrl, /\/host\/promotions\/\d+\/success$/);
  assert.equal(promotion().status, 'pending');
  assert.doesNotMatch((await request(app).get('/')).text, /badge-featured/);

  // A webhook for a session that doesn't match is ignored.
  await webhook('checkout.session.completed', {
    id: 'cs_other', payment_status: 'paid', payment_intent: 'pi_x', metadata: { promotion_id: String(promotion().id) },
  });
  assert.equal(promotion().status, 'pending');

  payments.pay('cs_test_1');
  const hook = await webhook('checkout.session.completed', {
    id: 'cs_test_1', payment_status: 'paid', payment_intent: 'pi_test_1', metadata: { promotion_id: String(promotion().id) },
  });
  assert.equal(hook.status, 200);
  assert.equal(promotion().status, 'paid');
  assert.equal(promotion().payment_reference, 'pi_test_1');
  assert.match((await request(app).get('/')).text, /badge-featured/);

  // Returning from Stripe afterwards just confirms it.
  const back = await host.get(`/host/promotions/${promotion().id}/success?session_id=cs_test_1`);
  assert.equal(back.headers.location, '/host');
  assert.match((await host.get('/host')).text, /is now featured/);
});

test('with Stripe: cancelling payment, an unavailable Stripe, and other hosts\' payments', async () => {
  start({ provider: fakeStripe() });
  const host = await signUp('host');
  const event = await createEvent(host);
  await feature(host, event, 1);

  const other = await signUp('host', 'other@test.com');
  assert.equal((await other.get(`/host/promotions/${promotion().id}/cancel`)).status, 404);

  await host.get(`/host/promotions/${promotion().id}/cancel`);
  assert.equal(promotion().status, 'failed');
  assert.equal(payments.sessions.get('cs_test_1').status, 'expired');

  payments.failStart = true;
  const res = await feature(host, event, 1);
  assert.equal(res.headers.location, `/host/events/${event.id}/feature`);
  assert.equal(promotion().status, 'failed');
});

test('with Stripe: a payment for an event cancelled meanwhile is refunded', async () => {
  start({ provider: fakeStripe() });
  const host = await signUp('host');
  const event = await createEvent(host);
  await feature(host, event, 3);
  const _csrf = await csrfFrom(host, '/host');
  await host.post(`/host/events/${event.id}/cancel`).type('form').send({ _csrf });

  payments.pay('cs_test_1');
  await webhook('checkout.session.completed', {
    id: 'cs_test_1', payment_status: 'paid', payment_intent: 'pi_test_1', metadata: { promotion_id: String(promotion().id) },
  });
  assert.equal(promotion().status, 'refunded');
  assert.deepEqual(payments.refunds, [{ reference: 'pi_test_1' }]);
});

test('a payment that would only buy days after the event starts is refunded', async () => {
  const refunds = [];
  start({ provider: { ...mockPayments, async refundPlatformCharge(args) { refunds.push(args); return { ok: true }; } } });
  const host = await signUp('host');
  const event = await createEvent(host, { days: 10 });
  const promotions = createPromotions({ db, payments });
  // Two purchases made side by side, each valid when it was chosen.
  const first = promotions.create({ event, hostId: 1, days: 14, amountCents: 2800 });
  const second = promotions.create({ event, hostId: 1, days: 1, amountCents: 200 });
  assert.equal(await promotions.fulfil(first.id, 'ref_1'), 'paid');
  assert.equal(await promotions.fulfil(second.id, 'ref_2'), 'refunded');
  assert.deepEqual(refunds, [{ reference: 'ref_2' }]);
});

test('a cancelled event no longer shows as featured', async () => {
  const host = await signUp('host');
  const event = await createEvent(host);
  await feature(host, event, 3);
  const _csrf = await csrfFrom(host, '/host');
  await host.post(`/host/events/${event.id}/cancel`).type('form').send({ _csrf });
  assert.doesNotMatch((await host.get('/host')).text, /badge-featured/);
  assert.doesNotMatch((await request(app).get('/')).text, /Featured/);
});

test('with Stripe: the sweep settles checkouts whose webhooks never arrived', async () => {
  start({ provider: fakeStripe() });
  const host = await signUp('host');
  const a = await createEvent(host, { title: 'A' });
  const b = await createEvent(host, { title: 'B' });
  await feature(host, a, 3);
  await feature(host, b, 3);
  payments.pay('cs_test_1');
  payments.sessions.get('cs_test_2').status = 'expired';
  db.prepare("UPDATE promotions SET expires_at = '2000-01-01T00:00:00.000Z'").run();

  await createPromotions({ db, payments }).sweep();
  const statuses = db.prepare('SELECT status FROM promotions ORDER BY id').all().map((r) => r.status);
  assert.deepEqual(statuses, ['paid', 'failed']);
});
