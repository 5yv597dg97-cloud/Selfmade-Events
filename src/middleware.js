import crypto from 'node:crypto';

export function loadUser(db) {
  const stmt = db.prepare('SELECT id, name, email, role, stripe_account_id, stripe_charges_enabled FROM users WHERE id = ?');
  return (req, res, next) => {
    req.user = req.session.userId ? stmt.get(req.session.userId) ?? null : null;
    res.locals.user = req.user;
    next();
  };
}

export function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  if (req.method === 'POST') {
    const token = req.body?._csrf;
    const expected = Buffer.from(req.session.csrf);
    const given = Buffer.from(String(token ?? ''));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'Invalid or missing form token. Please go back and try again.' });
    }
  }
  next();
}

export function flash(req, res, next) {
  res.locals.flash = req.session.flash ?? [];
  delete req.session.flash;
  req.flash = (type, message) => {
    (req.session.flash ??= []).push({ type, message });
  };
  next();
}

export function requireLogin(req, res, next) {
  if (req.user) return next();
  req.flash('info', 'Please log in to continue.');
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

export function requireHost(req, res, next) {
  if (!req.user) return requireLogin(req, res, next);
  if (req.user.role !== 'host') {
    return res.status(403).render('error', { title: 'Hosts only', message: 'You need a host account to manage events.' });
  }
  next();
}

/** Public base URL for links sent to third parties (payment redirects). */
export function appUrl(req) {
  const configured = process.env.APP_URL ?? process.env.RENDER_EXTERNAL_URL;
  return (configured ?? `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

export const SITE_DESCRIPTION = 'Discover upcoming events and book tickets in seconds, or host your own event and get paid straight to your bank.';

/** Defaults for the <head> tags that search engines and link previews read; pages override them. */
export function pageMeta(req, res, next) {
  const base = appUrl(req);
  res.locals.baseUrl = base;
  res.locals.canonicalUrl = `${base}${req.path}`;
  res.locals.description = SITE_DESCRIPTION;
  res.locals.ogImage = null;
  res.locals.ogType = 'website';
  res.locals.jsonLd = null;
  res.locals.noindex = false;
  next();
}
