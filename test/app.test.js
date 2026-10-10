import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

let db;
let app;
let paymentsOk;
let refunds;

beforeEach(() => {
  db = openDb();
  paymentsOk = true;
  refunds = [];
  const payments = {
    async charge() { return paymentsOk ? { ok: true, reference: 'ref_test' } : { ok: false, error: 'Card declined' }; },
    async refund(args) { refunds.push(args); return { ok: true }; },
  };
  app = createApp({ db, payments, sessionSecret: 'test' });
});

async function csrfFrom(agent, path = '/') {
  const res = await agent.get(path);
  const m = res.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(m, `no csrf token on ${path}`);
  return m[1];
}

async function signUp(role, email = `${role}@test.com`) {
  const agent = request.agent(app);
  const _csrf = await csrfFrom(agent, '/register');
  const res = await agent.post('/register').type('form').send({ _csrf, name: role, email, password: 'password123', role });
  assert.equal(res.status, 302);
  return agent;
}

function futureLocal(days = 10) {
  const d = new Date(Date.now() + days * 864e5);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T19:00`;
}

async function createEvent(host, { publish = '1', capacity = '5', price = '20' } = {}) {
  const _csrf = await csrfFrom(host, '/host/events/new');
  const res = await host.post('/host/events').type('form').send({
    _csrf, title: 'Test Party', description: 'Fun', venue: 'Hall', starts_at: futureLocal(), publish,
    'types[0][name]': 'GA', 'types[0][price]': price, 'types[0][capacity]': capacity,
  });
  assert.equal(res.status, 302, res.text);
  const event = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
  const type = db.prepare('SELECT * FROM ticket_types WHERE event_id = ?').get(event.id);
  return { event, type };
}

async function buy(agent, eventId, typeId, qty) {
  const _csrf = await csrfFrom(agent, `/events/${eventId}`);
  return agent.post(`/events/${eventId}/checkout`).type('form').send({ _csrf, [`qty_${typeId}`]: String(qty) });
}

test('POST without CSRF token is rejected', async () => {
  const res = await request(app).post('/login').type('form').send({ email: 'a@b.c', password: 'x' });
  assert.equal(res.status, 403);
});

test('clients cannot access the host dashboard', async () => {
  const client = await signUp('client');
  const res = await client.get('/host');
  assert.equal(res.status, 403);
});

test('host creates and publishes an event; it appears in listings', async () => {
  const host = await signUp('host');
  const { event, type } = await createEvent(host);
  assert.equal(event.status, 'published');
  assert.equal(type.price_cents, 2000);
  const home = await request(app).get('/');
  assert.match(home.text, /Test Party/);
});

test('drafts are hidden from the public until published', async () => {
  const host = await signUp('host');
  const { event } = await createEvent(host, { publish: '0' });
  assert.equal((await request(app).get(`/events/${event.id}`)).status, 404);
  assert.doesNotMatch((await request(app).get('/')).text, /Test Party/);
  const _csrf = await csrfFrom(host, '/host');
  await host.post(`/host/events/${event.id}/publish`).type('form').send({ _csrf });
  assert.equal((await request(app).get(`/events/${event.id}`)).status, 200);
});

test('event form validation reports errors', async () => {
  const host = await signUp('host');
  const _csrf = await csrfFrom(host, '/host/events/new');
  const res = await host.post('/host/events').type('form').send({ _csrf, title: '', venue: '', starts_at: '2000-01-01T10:00' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Title is required/);
  assert.match(res.text, /must be in the future/);
  assert.match(res.text, /at least one ticket type/);
});

test('client buys tickets and sees codes; host sees attendees and checks in', async () => {
  const host = await signUp('host');
  const { event, type } = await createEvent(host);
  const client = await signUp('client');

  const res = await buy(client, event.id, type.id, 2);
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/my-tickets/);

  const order = db.prepare('SELECT * FROM orders').get();
  assert.equal(order.status, 'paid');
  assert.equal(order.total_cents, 4000);
  assert.equal(db.prepare('SELECT sold FROM ticket_types WHERE id = ?').get(type.id).sold, 2);

  const tickets = db.prepare('SELECT code FROM tickets').all();
  assert.equal(tickets.length, 2);
  const mine = await client.get('/my-tickets');
  for (const t of tickets) assert.match(mine.text, new RegExp(t.code));

  const attendees = await host.get(`/host/events/${event.id}/attendees`);
  assert.match(attendees.text, /client@test.com/);

  const _csrf = await csrfFrom(host, `/host/events/${event.id}/attendees`);
  await host.post(`/host/events/${event.id}/checkin`).type('form').send({ _csrf, code: tickets[0].code.toLowerCase() });
  assert.ok(db.prepare('SELECT checked_in_at FROM tickets WHERE code = ?').get(tickets[0].code).checked_in_at);
  const again = await host.post(`/host/events/${event.id}/checkin`).type('form').send({ _csrf, code: tickets[0].code });
  const page = await host.get(again.headers.location);
  assert.match(page.text, /already checked in/);
});

test('cannot buy more tickets than remaining capacity', async () => {
  const host = await signUp('host');
  const { event, type } = await createEvent(host, { capacity: '3' });
  const a = await signUp('client', 'a@test.com');
  const b = await signUp('client', 'b@test.com');
  await buy(a, event.id, type.id, 2);
  const res = await buy(b, event.id, type.id, 2);
  const page = await b.get(res.headers.location);
  assert.match(page.text, /Not enough/);
  assert.equal(db.prepare('SELECT sold FROM ticket_types WHERE id = ?').get(type.id).sold, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'").get().n, 1);
});

test('concurrent purchases never oversell', async () => {
  const host = await signUp('host');
  const { event, type } = await createEvent(host, { capacity: '3' });
  const buyers = await Promise.all([1, 2, 3, 4, 5].map((i) => signUp('client', `c${i}@test.com`)));
  await Promise.all(buyers.map((b) => buy(b, event.id, type.id, 1)));
  assert.equal(db.prepare('SELECT sold FROM ticket_types WHERE id = ?').get(type.id).sold, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 3);
});

test('failed payment releases reserved tickets', async () => {
  const host = await signUp('host');
  const { event, type } = await createEvent(host);
  const client = await signUp('client');
  paymentsOk = false;
  const res = await buy(client, event.id, type.id, 2);
  assert.equal(res.headers.location, `/events/${event.id}`);
  assert.equal(db.prepare('SELECT sold FROM ticket_types WHERE id = ?').get(type.id).sold, 0);
  assert.equal(db.prepare('SELECT status FROM orders').get().status, 'failed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 0);
});

test('rejects invalid quantities and purchases of draft events', async () => {
  const host = await signUp('host');
  const { event, type } = await createEvent(host);
  const client = await signUp('client');
  await buy(client, event.id, type.id, -1);
  await buy(client, event.id, type.id, 99);
  await buy(client, event.id, type.id, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);

  const { event: draft, type: draftType } = await createEvent(host, { publish: '0' });
  const _csrf = await csrfFrom(client, '/');
  const res = await client.post(`/events/${draft.id}/checkout`).type('form').send({ _csrf, [`qty_${draftType.id}`]: '1' });
  assert.equal(res.status, 404);
});

test('hosts cannot manage other hosts\' events', async () => {
  const host = await signUp('host');
  const { event } = await createEvent(host);
  const other = await signUp('host', 'other@test.com');
  assert.equal((await other.get(`/host/events/${event.id}/edit`)).status, 404);
  assert.equal((await other.get(`/host/events/${event.id}/attendees`)).status, 404);
});

test('editing cannot lower capacity below tickets sold', async () => {
  const host = await signUp('host');
  const { event, type } = await createEvent(host, { capacity: '5' });
  const client = await signUp('client');
  await buy(client, event.id, type.id, 3);
  const _csrf = await csrfFrom(host, `/host/events/${event.id}/edit`);
  const res = await host.post(`/host/events/${event.id}`).type('form').send({
    _csrf, title: 'Renamed', venue: 'Hall', starts_at: futureLocal(),
    'types[0][id]': String(type.id), 'types[0][name]': 'GA', 'types[0][price]': '20', 'types[0][capacity]': '2',
  });
  assert.equal(res.status, 400);
  assert.match(res.text, /can&#39;t be lower than the 3 already sold/);
});

test('cancelling an event refunds every paid order', async () => {
  const host = await signUp('host');
  const { event, type } = await createEvent(host);
  const client = await signUp('client');
  await buy(client, event.id, type.id, 1);
  const _csrf = await csrfFrom(host, '/host');
  await host.post(`/host/events/${event.id}/cancel`).type('form').send({ _csrf });
  assert.equal(db.prepare('SELECT status FROM events WHERE id = ?').get(event.id).status, 'cancelled');
  assert.equal(db.prepare('SELECT status FROM orders').get().status, 'refunded');
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].amountCents, 2000);
});

test('login redirects only to local paths', async () => {
  await signUp('client');
  const agent = request.agent(app);
  const _csrf = await csrfFrom(agent, '/login');
  const res = await agent.post('/login').type('form').send({ _csrf, email: 'client@test.com', password: 'password123', next: '//evil.com' });
  assert.equal(res.headers.location, '/');
});
