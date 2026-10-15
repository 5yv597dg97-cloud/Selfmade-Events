// The site owner's earnings page and the fee arithmetic behind it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { mockPayments } from '../src/payments.js';
import { NO_FEES, exampleSale, estimateCardFee } from '../src/fees.js';
import { adminEmailsFromEnv } from '../src/middleware.js';

const FEES = { bookingFeePercent: 5, bookingFeeFixedPence: 30, commissionPercent: 10, featuredDayPence: 200 };

let db;
let app;

function start(fees = FEES) {
  db = openDb();
  app = createApp({ db, payments: mockPayments, fees, adminEmails: adminEmailsFromEnv({ ADMIN_EMAILS: 'Owner@Test.com' }), sessionSecret: 'test' });
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

async function createEvent(host) {
  const _csrf = await csrfFrom(host, '/host/events/new');
  await host.post('/host/events').type('form').send({
    _csrf, title: 'Jazz Night', venue: 'Hall', starts_at: futureLocal(), publish: '1',
    'types[0][name]': 'GA', 'types[0][price]': '20', 'types[0][capacity]': '50',
  });
  const event = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
  const type = db.prepare('SELECT * FROM ticket_types WHERE event_id = ?').get(event.id);
  return { event, type };
}

async function buy(agent, event, type, qty) {
  const _csrf = await csrfFrom(agent, `/events/${event.id}`);
  await agent.post(`/events/${event.id}/checkout`).type('form').send({ _csrf, [`qty_${type.id}`]: String(qty) });
}

test('only the site owner can see earnings', async () => {
  assert.match((await request(app).get('/admin')).headers.location, /^\/login/);
  const host = await signUp('host');
  assert.equal((await host.get('/admin')).status, 404);
  assert.doesNotMatch((await host.get('/')).text, /href="\/admin"/);

  const owner = await signUp('client', 'owner@test.com');
  const page = await owner.get('/admin');
  assert.equal(page.status, 200);
  assert.match(page.text, /Your earnings/);
  assert.match(page.text, /No sales yet/);
  assert.match((await owner.get('/')).text, /href="\/admin"/);
});

test('earnings add up booking fees, commission and featured listings, minus card fees', async () => {
  const host = await signUp('host');
  const { event, type } = await createEvent(host);
  const client = await signUp('client');
  await buy(client, event, type, 2);
  const _csrf = await csrfFrom(host, `/host/events/${event.id}/feature`);
  await host.post(`/host/events/${event.id}/feature`).type('form').send({ _csrf, days: '3' });

  // A refunded order earns nothing but still cost a card fee.
  await buy(client, event, type, 1);
  const refunded = db.prepare('SELECT id FROM orders ORDER BY id DESC LIMIT 1').get().id;
  db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(refunded);

  const owner = await signUp('client', 'owner@test.com');
  const page = (await owner.get('/admin')).text;
  // Paid order: 2 x £20, booking fee 2 x (£1 + 30p) = £2.60, commission 10% = £4.00.
  // Featured: 3 days x £2 = £6.00. Income = £12.60.
  assert.match(page, /£12\.60/);
  // Card fees (1.5% + 20p): £42.60 order -> 84p, £6 feature -> 29p, refunded £21.30 order -> 52p.
  // Profit = £12.60 - £1.65 = £10.95.
  assert.match(page, /£10\.95/);
  assert.match(page, /£40\.00/); // ticket sales
  assert.match(page, /Jazz Night/);
  assert.doesNotMatch(page, /you lose about/);
});

test('the owner is warned when fees lose money on every sale', async () => {
  start(NO_FEES);
  const owner = await signUp('client', 'owner@test.com');
  const page = (await owner.get('/admin')).text;
  assert.match(page, /you lose about £0\.35 on every £10\.00 ticket/);
});

test('example sale: who gets what from one ticket', () => {
  assert.equal(estimateCardFee(0), 0);
  assert.equal(estimateCardFee(1080), 36);
  assert.deepEqual(exampleSale(FEES), {
    price: 1000, bookingFee: 80, buyerPays: 1080, commission: 100, platformFee: 180, cardFee: 36, net: 144, hostGets: 900,
  });
  assert.equal(exampleSale(NO_FEES).net, -35);
});

test('the default production fees (5% + 30p) keep a profit even on cards from abroad', () => {
  const fees = { bookingFeePercent: 5, bookingFeeFixedPence: 30, commissionPercent: 0 };
  for (const price of [1, 100, 500, 1000, 2500, 10000, 100000]) {
    const sale = exampleSale(fees, price);
    const worstCardFee = Math.round(sale.buyerPays * 0.0325) + 20; // international card
    assert.ok(sale.platformFee > worstCardFee, `£${price / 100} ticket`);
    assert.equal(sale.hostGets, price);
  }
});

test('admin emails are read from a comma or space separated list', () => {
  assert.deepEqual([...adminEmailsFromEnv({ ADMIN_EMAILS: ' A@x.com, b@y.co.uk  c@z.io,' })], ['a@x.com', 'b@y.co.uk', 'c@z.io']);
  assert.equal(adminEmailsFromEnv({}).size, 0);
});
