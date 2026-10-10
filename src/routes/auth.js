import { Router } from 'express';
import bcrypt from 'bcryptjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Only allow redirects to local paths. */
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : null;
}

export default function authRoutes({ db }) {
  const router = Router();
  const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const insertUser = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)');

  function logIn(req, userId, done) {
    // New session id on login prevents session fixation.
    req.session.regenerate((err) => {
      if (err) return done(err);
      req.session.userId = userId;
      done();
    });
  }

  router.get('/register', (req, res) => {
    res.render('register', { title: 'Create account', values: { role: req.query.role === 'host' ? 'host' : 'client' }, errors: [] });
  });

  router.post('/register', async (req, res, next) => {
    const name = String(req.body.name ?? '').trim();
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');
    const role = req.body.role === 'host' ? 'host' : 'client';

    const errors = [];
    if (!name) errors.push('Name is required.');
    if (!EMAIL_RE.test(email)) errors.push('Enter a valid email address.');
    if (password.length < 8) errors.push('Password must be at least 8 characters.');
    if (!errors.length && findByEmail.get(email)) errors.push('An account with that email already exists.');
    if (errors.length) {
      return res.status(400).render('register', { title: 'Create account', values: { name, email, role }, errors });
    }

    try {
      const hash = await bcrypt.hash(password, 10);
      const { lastInsertRowid } = insertUser.run(name, email, hash, role);
      logIn(req, Number(lastInsertRowid), (err) => {
        if (err) return next(err);
        req.flash('success', `Welcome, ${name}!`);
        res.redirect(role === 'host' ? '/host' : '/');
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/login', (req, res) => {
    res.render('login', { title: 'Log in', values: {}, next: safeNext(req.query.next), errors: [] });
  });

  router.post('/login', async (req, res, next) => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');
    const nextUrl = safeNext(req.body.next);
    try {
      const user = findByEmail.get(email);
      const ok = user && (await bcrypt.compare(password, user.password_hash));
      if (!ok) {
        return res.status(401).render('login', { title: 'Log in', values: { email }, next: nextUrl, errors: ['Incorrect email or password.'] });
      }
      logIn(req, user.id, (err) => {
        if (err) return next(err);
        res.redirect(nextUrl ?? (user.role === 'host' ? '/host' : '/'));
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.redirect('/');
    });
  });

  return router;
}
