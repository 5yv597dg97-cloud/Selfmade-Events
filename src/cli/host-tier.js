// Set a host's payout tier.
// Usage: npm run host:tier -- <email> <trusted|standard|auto>
//   trusted   daily payouts + instant payouts
//   standard  paid out a few days after each event
//   auto      trusted automatically after enough successful events (default)
import { openDb } from '../db.js';
import { createPayouts } from '../payouts.js';
import { mockPayments } from '../payments.js';

const [email, tier] = process.argv.slice(2);
if (!email || !['trusted', 'standard', 'auto'].includes(tier)) {
  console.error('Usage: npm run host:tier -- <email> <trusted|standard|auto>');
  process.exit(1);
}
const db = openDb(process.env.DATABASE_PATH ?? 'selfmade-events.db');
const host = db.prepare("SELECT * FROM users WHERE email = ? AND role = 'host'").get(email.toLowerCase());
if (!host) {
  console.error(`No host account with email ${email}`);
  process.exit(1);
}
const payouts = createPayouts({ db, payments: mockPayments });
payouts.setHostTier(host.id, tier);
const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(host.id);
console.log(`${host.name} <${host.email}>: payout tier set to "${tier}" (currently ${payouts.isTrusted(updated) ? 'trusted' : 'standard'}).`);
