import { createApp } from './app.js';
import { openDb } from './db.js';
import { paymentsFromEnv } from './payments.js';
import { feeConfigFromEnv, exampleSale } from './fees.js';
import { assistantFromEnv } from './assistant/index.js';

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET must be set in production.');
  process.exit(1);
}

let payments;
let fees;
try {
  payments = paymentsFromEnv();
  fees = feeConfigFromEnv();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const sale = exampleSale(fees);
if (payments.name === 'stripe' && sale.net < 0) {
  // Stripe's card fee comes out of the platform's share, so zero fees lose money on every sale.
  console.warn(`Fees don't cover Stripe's card fee: about ${-sale.net}p is lost on every £10 ticket sold. `
    + 'Set BOOKING_FEE_PERCENT, BOOKING_FEE_FIXED_PENCE or PLATFORM_COMMISSION_PERCENT.');
}

const db = openDb(process.env.DATABASE_PATH ?? 'selfmade-events.db');
const assistant = assistantFromEnv({ db, fees, payments });
const app = createApp({ db, payments, fees, assistant, sweepIntervalMs: 5 * 60 * 1000 });
assistant.start();
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`Selfmade Events running at http://localhost:${port} (payments: ${payments.name})`);
});
