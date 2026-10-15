// Populate the database with demo accounts and events.
// Usage: npm run seed   (uses DATABASE_PATH or selfmade-events.db)
import bcrypt from 'bcryptjs';
import { openDb, transaction } from './db.js';
import { parseInputDateTime, toInputDateTime } from './format.js';

const db = openDb(process.env.DATABASE_PATH ?? 'selfmade-events.db');
const hash = bcrypt.hashSync('password123', 10);
const day = 24 * 60 * 60 * 1000;
// `hour` is UK time on the day `n` days from now.
const inDays = (n, hour) => {
  const date = toInputDateTime(new Date(Date.now() + n * day).toISOString()).slice(0, 10);
  return parseInputDateTime(`${date}T${String(hour).padStart(2, '0')}:00`).toISOString();
};

transaction(db, () => {
  const addUser = db.prepare('INSERT OR IGNORE INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)');
  addUser.run('Demo Host', 'host@example.com', hash, 'host');
  addUser.run('Demo Client', 'client@example.com', hash, 'client');
  addUser.run('Site Owner', 'owner@example.com', hash, 'client'); // run with ADMIN_EMAILS=owner@example.com
  const hostId = db.prepare('SELECT id FROM users WHERE email = ?').get('host@example.com').id;
  if (db.prepare('SELECT COUNT(*) AS n FROM events WHERE host_id = ?').get(hostId).n > 0) return;

  const addEvent = db.prepare("INSERT INTO events (host_id, title, description, venue, starts_at, status) VALUES (?, ?, ?, ?, ?, 'published')");
  const addType = db.prepare('INSERT INTO ticket_types (event_id, name, price_cents, capacity) VALUES (?, ?, ?, ?)');
  const events = [
    ['Rooftop Jazz Night', 'Live jazz trio, city views and signature cocktails.', 'Skyline Terrace, 20 Bankside, London SE1', inDays(7, 19),
      [['General admission', 2000, 120], ['VIP table', 7500, 10]]],
    ['Startup Pitch Breakfast', 'Five founders, five minutes each, unlimited tea and coffee.', 'The Hub, 45 Old Street, London EC1', inDays(14, 8),
      [['Attendee', 0, 80]]],
    ['Pottery Workshop for Beginners', 'Hands-on wheel throwing. All materials included.', 'Clay Studio, 12 Elm Row, Edinburgh', inDays(21, 14),
      [['Workshop seat', 5500, 12]]],
  ];
  for (const [title, description, venue, startsAt, types] of events) {
    const id = Number(addEvent.run(hostId, title, description, venue, startsAt).lastInsertRowid);
    for (const [name, price, capacity] of types) addType.run(id, name, price, capacity);
  }
});

console.log('Seeded. Log in as host@example.com, client@example.com or owner@example.com with password "password123".');
