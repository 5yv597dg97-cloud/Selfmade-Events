import { createApp } from './app.js';
import { openDb } from './db.js';

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET must be set in production.');
  process.exit(1);
}

const db = openDb(process.env.DATABASE_PATH ?? 'selfmade-events.db');
const app = createApp({ db });
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`Selfmade Events running at http://localhost:${port}`);
});
