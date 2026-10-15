import { createApp } from './app.js';
import { openDb } from './db.js';
import { paymentsFromEnv } from './payments.js';
import { feeConfigFromEnv } from './fees.js';
import { payoutConfigFromEnv } from './payouts.js';

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET must be set in production.');
  process.exit(1);
}

let payments;
let fees;
let payoutConfig;
try {
  payments = paymentsFromEnv();
  fees = feeConfigFromEnv();
  payoutConfig = payoutConfigFromEnv();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const db = openDb(process.env.DATABASE_PATH ?? 'selfmade-events.db');
const app = createApp({
  db, payments, fees, payoutConfig,
  sweepIntervalMs: 5 * 60 * 1000, // settle abandoned checkouts
  payoutIntervalMs: 60 * 60 * 1000, // pay hosts (each at most once a day)
});
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`Selfmade Events running at http://localhost:${port} (payments: ${payments.name})`);
});
