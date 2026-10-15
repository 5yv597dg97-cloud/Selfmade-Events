import { Router } from 'express';
import { requireLogin, appUrl } from '../middleware.js';
import { priceOrder, bookingFeeFor } from '../fees.js';
import { CHECKOUT_HOLD_MS, SoldOutError } from '../orders.js';
import { eventIcs, googleCalendarUrl, DEFAULT_EVENT_HOURS } from '../calendar.js';
import { excerpt, CURRENCY } from '../format.js';

export const MAX_TICKETS_PER_TYPE = 10;

export default function eventRoutes({ db, payments, fees, orders }) {
  const router = Router();

  const listUpcoming = db.prepare(`
    SELECT e.*, u.name AS host_name,
           MIN(t.price_cents) AS min_price, MAX(t.price_cents) AS max_price,
           COALESCE(SUM(t.capacity - t.sold), 0) AS remaining
    FROM events e
    JOIN users u ON u.id = e.host_id
    LEFT JOIN ticket_types t ON t.event_id = e.id
    WHERE e.status = 'published' AND e.starts_at >= ?
      AND (? = '' OR e.title LIKE ? OR e.venue LIKE ? OR e.description LIKE ?)
    GROUP BY e.id
    ORDER BY e.starts_at
    LIMIT 100`);
  const listForSitemap = db.prepare(`SELECT id, created_at FROM events WHERE status = 'published' AND starts_at >= ? ORDER BY starts_at LIMIT 5000`);
  const getEvent = db.prepare(`
    SELECT e.*, u.name AS host_name, u.stripe_account_id AS host_stripe_account_id, u.stripe_charges_enabled AS host_charges_enabled
    FROM events e JOIN users u ON u.id = e.host_id WHERE e.id = ?`);
  const getTypes = db.prepare('SELECT * FROM ticket_types WHERE event_id = ? ORDER BY price_cents, id');

  /** An event is visible to the public once published (or cancelled, so buyers see the notice). */
  function isVisible(event, user) {
    return event && (event.status !== 'draft' || event.host_id === user?.id);
  }

  router.get('/', (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    const like = `%${q}%`;
    const events = listUpcoming.all(new Date().toISOString(), q, like, like, like);
    res.render('events/index', { title: 'Upcoming events', events, q, noindex: q !== '' });
  });

  router.get('/robots.txt', (req, res) => {
    res.type('text').send(`User-agent: *\nDisallow: /host\nDisallow: /my-tickets\nDisallow: /orders\nSitemap: ${res.locals.baseUrl}/sitemap.xml\n`);
  });

  router.get('/sitemap.xml', (req, res) => {
    const base = res.locals.baseUrl;
    const urls = [`${base}/`, ...listForSitemap.all(new Date().toISOString()).map((e) => `${base}/events/${e.id}`)];
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
        urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}\n</urlset>\n`,
    );
  });

  router.get('/events/:id/calendar.ics', (req, res, next) => {
    const event = getEvent.get(Number(req.params.id));
    if (!isVisible(event, req.user)) return next();
    const url = `${res.locals.baseUrl}/events/${event.id}`;
    res.type('text/calendar; charset=utf-8')
      .attachment(`event-${event.id}.ics`)
      .send(eventIcs(event, { url, host: req.hostname }));
  });

  router.get('/events/:id', (req, res, next) => {
    const event = getEvent.get(Number(req.params.id));
    if (!isVisible(event, req.user)) return next();
    const types = getTypes.all(event.id).map((t) => ({ ...t, booking_fee: bookingFeeFor(t.price_cents, fees) }));
    const salesBlocked = payments.requiresHostAccount && !event.host_charges_enabled && types.some((t) => t.price_cents > 0);
    const url = `${res.locals.baseUrl}/events/${event.id}`;
    res.render('events/show', {
      title: event.title, event, types, max: MAX_TICKETS_PER_TYPE, salesBlocked,
      description: excerpt(event.description) || `${event.title} at ${event.venue}. Book tickets on Selfmade Events.`,
      ogImage: event.image_url, noindex: event.status === 'draft',
      jsonLd: eventJsonLd(event, types, url),
      googleCalendarUrl: googleCalendarUrl(event, { url }),
      mapUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.venue)}`,
    });
  });

  router.post('/events/:id/checkout', requireLogin, async (req, res, next) => {
    const event = getEvent.get(Number(req.params.id));
    if (!isVisible(event, req.user)) return next();
    const back = `/events/${event.id}`;

    if (event.status !== 'published' || new Date(event.starts_at) < new Date()) {
      req.flash('error', 'Tickets for this event are no longer on sale.');
      return res.redirect(back);
    }

    const types = getTypes.all(event.id);
    const lines = [];
    for (const type of types) {
      const raw = req.body[`qty_${type.id}`];
      if (raw === undefined || raw === '') continue;
      const qty = Number(raw);
      if (!Number.isInteger(qty) || qty < 0 || qty > MAX_TICKETS_PER_TYPE) {
        req.flash('error', `Choose between 0 and ${MAX_TICKETS_PER_TYPE} tickets per type.`);
        return res.redirect(back);
      }
      if (qty > 0) lines.push({ type, qty });
    }
    if (!lines.length) {
      req.flash('error', 'Select at least one ticket.');
      return res.redirect(back);
    }
    const pricing = priceOrder(lines, fees);
    const needsHostAccount = pricing.total > 0 && payments.requiresHostAccount;
    if (needsHostAccount && !event.host_charges_enabled) {
      req.flash('error', "The host hasn't finished setting up payments yet, so paid tickets can't be sold right now.");
      return res.redirect(back);
    }

    // 1. Hold the seats and create a pending order.
    let orderId;
    try {
      orderId = orders.reserve({ userId: req.user.id, eventId: event.id, lines, pricing, expiresAt: new Date(Date.now() + CHECKOUT_HOLD_MS) });
    } catch (err) {
      if (err instanceof SoldOutError) {
        req.flash('error', `Not enough "${err.message}" tickets left. Please choose fewer.`);
        return res.redirect(back);
      }
      return next(err);
    }

    const done = () => {
      req.flash('success', 'Your tickets are booked!');
      res.redirect(`/my-tickets#order-${orderId}`);
    };
    if (pricing.total === 0) {
      await orders.fulfil(orderId, 'free');
      return done();
    }

    // 2. Start payment; release the seats if it can't start.
    let result;
    try {
      const base = appUrl(req);
      result = await payments.startCheckout({
        orderId, event, lines, pricing,
        hostAccountId: event.host_stripe_account_id,
        buyerEmail: req.user.email,
        successUrl: `${base}/orders/${orderId}/success`,
        cancelUrl: `${base}/orders/${orderId}/cancel`,
        expiresAt: new Date(Date.now() + CHECKOUT_HOLD_MS),
      });
    } catch (err) {
      console.error(`Order ${orderId}: checkout failed to start:`, err.message);
      orders.release(orderId);
      req.flash('error', "We couldn't start the payment. You have not been charged. Please try again.");
      return res.redirect(back);
    }

    if (result.status === 'paid') {
      await orders.fulfil(orderId, result.reference);
      return done();
    }
    orders.attachCheckout(orderId, result.sessionId);
    res.redirect(303, result.url);
  });

  return router;
}

/** schema.org Event data, which lets search engines show the event with its date, place and prices. */
function eventJsonLd(event, types, url) {
  const start = new Date(event.starts_at);
  const status = event.status === 'cancelled' ? 'EventCancelled' : 'EventScheduled';
  return {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: event.title,
    description: excerpt(event.description, 500) || undefined,
    startDate: start.toISOString(),
    endDate: new Date(start.getTime() + DEFAULT_EVENT_HOURS * 3600 * 1000).toISOString(),
    eventStatus: `https://schema.org/${status}`,
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: { '@type': 'Place', name: event.venue, address: event.venue },
    image: event.image_url ? [event.image_url] : undefined,
    organizer: { '@type': 'Person', name: event.host_name },
    url,
    offers: types.map((t) => ({
      '@type': 'Offer',
      name: t.name,
      price: ((t.price_cents + t.booking_fee) / 100).toFixed(2),
      priceCurrency: CURRENCY,
      availability: `https://schema.org/${t.capacity > t.sold ? 'InStock' : 'SoldOut'}`,
      url,
    })),
  };
}
