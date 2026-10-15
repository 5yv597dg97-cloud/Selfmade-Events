import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { eventIcs } from '../src/calendar.js';
import { dateBadge, excerpt } from '../src/format.js';

function appWithEvent({ status = 'published', description = 'Live jazz, city views.' } = {}) {
  const db = openDb();
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Host', 'h@test.com', 'x', 'host')").run();
  const startsAt = new Date(Date.now() + 7 * 864e5).toISOString();
  db.prepare('INSERT INTO events (host_id, title, description, venue, starts_at, status) VALUES (1, ?, ?, ?, ?, ?)')
    .run('Jazz </script> Night', description, 'Skyline, 20 Bankside, London', startsAt, status);
  db.prepare("INSERT INTO ticket_types (event_id, name, price_cents, capacity, sold) VALUES (1, 'GA', 2000, 5, 0)").run();
  return createApp({ db, sessionSecret: 'test' });
}

test('event page has meta description, canonical link and safe schema.org data', async () => {
  const res = await request(appWithEvent()).get('/events/1');
  assert.equal(res.status, 200);
  assert.match(res.text, /<meta name="description" content="Live jazz, city views.">/);
  assert.match(res.text, /<link rel="canonical" href="http:\/\/127\.0\.0\.1:\d+\/events\/1">/);
  const ld = JSON.parse(res.text.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
  assert.equal(ld['@type'], 'Event');
  assert.equal(ld.name, 'Jazz </script> Night');
  assert.equal(ld.offers[0].price, '20.00');
  assert.equal(ld.offers[0].availability, 'https://schema.org/InStock');
  assert.match(res.text, /Only 5 left/);
});

test('drafts are hidden from the public', async () => {
  const res = await request(appWithEvent({ status: 'draft' })).get('/events/1');
  assert.equal(res.status, 404);
});

test('calendar file downloads for a published event', async () => {
  const res = await request(appWithEvent()).get('/events/1/calendar.ics');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/calendar/);
  assert.match(res.text, /SUMMARY:Jazz <\/script> Night/);
  assert.match(res.text, /LOCATION:Skyline\\, 20 Bankside\\, London/);
});

test('robots.txt and sitemap list public pages only', async () => {
  const app = appWithEvent();
  const robots = await request(app).get('/robots.txt');
  assert.match(robots.text, /Disallow: \/host/);
  assert.match(robots.text, /Sitemap: .*\/sitemap\.xml/);
  const sitemap = await request(app).get('/sitemap.xml');
  assert.match(sitemap.headers['content-type'], /xml/);
  assert.match(sitemap.text, /<loc>[^<]*\/events\/1<\/loc>/);
});

test('ics lines are folded at 75 octets and end with CRLF', () => {
  const ics = eventIcs({ id: 1, title: 'x'.repeat(200), venue: 'v', description: '', starts_at: '2026-11-01T19:00:00Z', status: 'published' });
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.ok(ics.endsWith('\r\n'));
});

test('dateBadge uses UK time and excerpt cuts at a word', () => {
  // 23:30 UTC is 00:30 the next day in British Summer Time.
  assert.deepEqual(dateBadge('2026-07-31T23:30:00Z'), { day: '1', month: 'Aug', weekday: 'Sat' });
  assert.equal(excerpt('one two three', 9), 'one two…');
  assert.equal(excerpt('  short\n text '), 'short text');
});
