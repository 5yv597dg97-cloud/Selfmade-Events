import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import session from 'express-session';
import { openDb } from './db.js';
import { mockPayments } from './payments.js';
import { NO_FEES } from './fees.js';
import { createOrders } from './orders.js';
import { createPromotions } from './promotions.js';
import { SqliteSessionStore } from './session-store.js';
import { loadUser, csrf, flash, adminEmailsFromEnv } from './middleware.js';
import * as format from './format.js';
import authRoutes from './routes/auth.js';
import eventRoutes from './routes/events.js';
import hostRoutes from './routes/host.js';
import ticketRoutes from './routes/tickets.js';
import webhookRoutes from './routes/webhooks.js';
import adminRoutes from './routes/admin.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function createApp({
  db = openDb(),
  payments = mockPayments,
  fees = NO_FEES,
  adminEmails = adminEmailsFromEnv(),
  sweepIntervalMs = null,
  sessionSecret = process.env.SESSION_SECRET ?? crypto.randomBytes(32).toString('hex'),
} = {}) {
  const app = express();
  const production = process.env.NODE_ENV === 'production';
  // Behind Render's (or any) HTTPS proxy: trust X-Forwarded-Proto so secure cookies work.
  if (production) app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));
  app.locals.format = format;
  app.locals.paymentsProvider = payments.name;

  const orders = createOrders({ db, payments });
  const promotions = createPromotions({ db, payments });
  if (sweepIntervalMs) {
    setInterval(() => {
      orders.sweep().then(() => promotions.sweep()).catch((err) => console.error('Sweep failed:', err));
    }, sweepIntervalMs).unref();
  }
  const ctx = { db, payments, fees, orders, promotions };

  app.get('/healthz', (req, res) => {
    db.prepare('SELECT 1').get();
    res.type('text').send('ok');
  });
  // Before the body parser, session and CSRF: Stripe signs the raw JSON body.
  app.use(webhookRoutes(ctx));
  app.use(express.static(path.join(root, 'public')));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(session({
    secret: sessionSecret,
    store: new SqliteSessionStore(db),
    resave: false,
    saveUninitialized: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 14 * 24 * 60 * 60 * 1000 },
  }));
  app.use(flash);
  app.use(loadUser(db, adminEmails));
  app.use(csrf);

  app.use(authRoutes(ctx));
  app.use(eventRoutes(ctx));
  app.use('/host', hostRoutes(ctx));
  app.use(ticketRoutes(ctx));
  app.use('/admin', adminRoutes(ctx));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: "We couldn't find that page." });
  });
  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again.' });
  });

  return app;
}
