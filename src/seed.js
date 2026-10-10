// Populate the database with demo accounts and events.
// Usage: npm run seed   (uses DATABASE_PATH or selfmade-events.db)
import bcrypt from 'bcryptjs';
import { openDb, transaction } from './db.js';

const db = openDb(process.env.DATABASE_PATH ?? 'selfmade-events.db');
const hash = bcrypt.hashSync('password123', 10);
const day = 24 * 60 * 60 * 1000;
const inDays = (n, hour) => {
  const d = new Date(Date.now() + n * day);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

transaction(db, () => {
  const addUser = db.prepare('INSERT OR IGNORE INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)');
  addUser.run('Demo Host', 'host@example.com', hash, 'host');
  addUser.run('Demo Client', 'client@example.com', hash, 'client');
  const hostId = db.prepare('SELECT id FROM users WHERE email = ?').get('host@example.com').id;
  if (db.prepare('SELECT COUNT(*) AS n FROM events WHERE host_id = ?').get(hostId).n > 0) return;

  const addEvent = db.prepare("INSERT INTO events (host_id, title, description, venue, starts_at, status) VALUES (?, ?, ?, ?, ?, 'published')");
  const addType = db.prepare('INSERT INTO ticket_types (event_id, name, price_cents, capacity) VALUES (?, ?, ?, ?)');
  const events = [
    ['Rooftop Jazz Night', 'Live jazz trio, city views and signature cocktails.', 'Skyline Terrace, 200 Main St', inDays(7, 19),
      [['General admission', 2500, 120], ['VIP table', 9000, 10]]],
    ['Startup Pitch Breakfast', 'Five founders, five minutes each, unlimited coffee.', 'The Hub, 45 Market St', inDays(14, 8),
      [['Attendee', 0, 80]]],
    ['Pottery Workshop for Beginners', 'Hands-on wheel throwing. All materials included.', 'Clay Studio, 12 Elm Ave', inDays(21, 14),
      [['Workshop seat', 6500, 12]]],
  ];
  for (const [title, description, venue, startsAt, types] of events) {
    const id = Number(addEvent.run(hostId, title, description, venue, startsAt).lastInsertRowid);
    for (const [name, price, capacity] of types) addType.run(id, name, price, capacity);
  }
});

console.log('Seeded. Log in as host@example.com or client@example.com with password "password123".');
