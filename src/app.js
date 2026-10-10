import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import session from 'express-session';
import { openDb } from './db.js';
import { mockPayments } from './payments.js';
import { loadUser, csrf, flash } from './middleware.js';
import * as format from './format.js';
import authRoutes from './routes/auth.js';
import eventRoutes from './routes/events.js';
import hostRoutes from './routes/host.js';
import ticketRoutes from './routes/tickets.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function createApp({
  db = openDb(),
  payments = mockPayments,
  sessionSecret = process.env.SESSION_SECRET ?? crypto.randomBytes(32).toString('hex'),
} = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));
  app.locals.format = format;

  app.use(express.static(path.join(root, 'public')));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' },
  }));
  app.use(flash);
  app.use(loadUser(db));
  app.use(csrf);

  const ctx = { db, payments };
  app.use(authRoutes(ctx));
  app.use(eventRoutes(ctx));
  app.use('/host', hostRoutes(ctx));
  app.use(ticketRoutes(ctx));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: "We couldn't find that page." });
  });
  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again.' });
  });

  return app;
}
