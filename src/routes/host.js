import { Router } from 'express';
import { transaction } from '../db.js';
import { requireHost, appUrl } from '../middleware.js';
import { PayoutError } from '../payouts.js';
import { money, parseCents, parseInputDateTime, toInputDateTime } from '../format.js';

const MAX_TYPES = 10;

/** Validate the event form. `existing` maps ticket type id -> current row (for edits). */
function parseEventForm(body, existing = new Map()) {
  const errors = [];
  const values = {
    title: String(body.title ?? '').trim(),
    description: String(body.description ?? '').trim(),
    venue: String(body.venue ?? '').trim(),
    starts_at: String(body.starts_at ?? '').trim(),
    image_url: String(body.image_url ?? '').trim(),
  };
  if (!values.title) errors.push('Title is required.');
  if (values.title.length > 150) errors.push('Title must be 150 characters or fewer.');
  if (!values.venue) errors.push('Venue is required.');
  if (values.description.length > 5000) errors.push('Description must be 5000 characters or fewer.');
  const startsAt = parseInputDateTime(values.starts_at);
  if (!values.starts_at || Number.isNaN(startsAt.getTime())) errors.push('Enter a valid start date and time.');
  else if (startsAt < new Date()) errors.push('Start time must be in the future.');
  if (values.image_url && !/^https?:\/\/\S+$/i.test(values.image_url)) errors.push('Image URL must start with http:// or https://');

  const rows = Object.values(body.types ?? {}).slice(0, MAX_TYPES + 5);
  const types = [];
  for (const row of rows) {
    const id = row.id ? Number(row.id) : null;
    const current = id ? existing.get(id) : null;
    if (id && !current) continue; // ignore ids that don't belong to this event
    const t = {
      id,
      name: String(row.name ?? '').trim(),
      price: String(row.price ?? '').trim(),
      capacity: String(row.capacity ?? '').trim(),
      sold: current?.sold ?? 0,
      remove: row.remove === '1',
    };
    const blank = !t.name && !t.price && !t.capacity;
    if (!id && blank) continue; // skip empty "new" rows
    if (t.remove) {
      if (t.sold > 0) errors.push(`"${current.name}" has sales and can't be removed.`);
      types.push(t);
      continue;
    }
    t.price_cents = parseCents(t.price);
    t.capacity_n = Number(t.capacity);
    const label = t.name || 'Ticket type';
    if (!t.name) errors.push('Every ticket type needs a name.');
    if (Number.isNaN(t.price_cents)) errors.push(`${label}: price must be an amount in pounds, like 25 or 12.50.`);
    if (!Number.isInteger(t.capacity_n) || t.capacity_n < 1 || t.capacity_n > 100000) {
      errors.push(`${label}: capacity must be a whole number between 1 and 100000.`);
    } else if (t.capacity_n < t.sold) {
      errors.push(`${label}: capacity can't be lower than the ${t.sold} already sold.`);
    }
    types.push(t);
  }
  const kept = types.filter((t) => !t.remove);
  if (!kept.length) errors.push('Add at least one ticket type.');
  if (kept.length > MAX_TYPES) errors.push(`At most ${MAX_TYPES} ticket types per event.`);

  return { values, startsAtIso: errors.length ? null : startsAt.toISOString(), types, errors };
}

function formTypesFromRows(rows) {
  return rows.map((t) => ({ id: t.id, name: t.name, price: (t.price_cents / 100).toFixed(2), capacity: String(t.capacity), sold: t.sold }));
}

export default function hostRoutes({ db, payments, payouts }) {
  const router = Router();
  router.use(requireHost);

  const hostEvents = db.prepare(`
    SELECT e.*,
      COALESCE((SELECT SUM(capacity) FROM ticket_types WHERE event_id = e.id), 0) AS capacity,
      COALESCE((SELECT SUM(sold) FROM ticket_types WHERE event_id = e.id), 0) AS sold,
      COALESCE((SELECT SUM(subtotal_cents - commission_cents) FROM orders WHERE event_id = e.id AND status = 'paid'), 0) AS earnings_cents
    FROM events e WHERE e.host_id = ? ORDER BY e.starts_at DESC`);
  const getOwnEvent = db.prepare('SELECT * FROM events WHERE id = ? AND host_id = ?');
  const getTypes = db.prepare('SELECT * FROM ticket_types WHERE event_id = ? ORDER BY id');
  const insertEvent = db.prepare('INSERT INTO events (host_id, title, description, venue, starts_at, image_url) VALUES (?, ?, ?, ?, ?, ?)');
  const updateEvent = db.prepare('UPDATE events SET title = ?, description = ?, venue = ?, starts_at = ?, image_url = ? WHERE id = ?');
  const insertType = db.prepare('INSERT INTO ticket_types (event_id, name, price_cents, capacity) VALUES (?, ?, ?, ?)');
  const updateType = db.prepare('UPDATE ticket_types SET name = ?, price_cents = ?, capacity = ? WHERE id = ? AND event_id = ? AND sold <= ?');
  const deleteType = db.prepare('DELETE FROM ticket_types WHERE id = ? AND event_id = ? AND sold = 0');
  const setStatus = db.prepare('UPDATE events SET status = ? WHERE id = ?');
  const paidOrders = db.prepare("SELECT * FROM orders WHERE event_id = ? AND status = 'paid'");
  const hasPaidTypes = db.prepare('SELECT 1 FROM ticket_types WHERE event_id = ? AND price_cents > 0 LIMIT 1');
  const setStripeAccount = db.prepare('UPDATE users SET stripe_account_id = ? WHERE id = ?');
  const setChargesEnabled = db.prepare('UPDATE users SET stripe_charges_enabled = ? WHERE id = ?');
  const refundOrder = db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ? AND status = 'paid'");
  const attendees = db.prepare(`
    SELECT t.id, t.code, t.checked_in_at, tt.name AS type_name, u.name AS buyer_name, u.email AS buyer_email, o.id AS order_id
    FROM tickets t
    JOIN orders o ON o.id = t.order_id
    JOIN ticket_types tt ON tt.id = t.ticket_type_id
    JOIN users u ON u.id = o.user_id
    WHERE o.event_id = ? AND o.status = 'paid'
    ORDER BY u.name, t.id`);
  const findTicket = db.prepare(`
    SELECT t.*, tt.name AS type_name, u.name AS buyer_name
    FROM tickets t
    JOIN orders o ON o.id = t.order_id
    JOIN ticket_types tt ON tt.id = t.ticket_type_id
    JOIN users u ON u.id = o.user_id
    WHERE t.code = ? AND o.event_id = ? AND o.status = 'paid'`);
  const checkIn = db.prepare("UPDATE tickets SET checked_in_at = datetime('now') WHERE id = ? AND checked_in_at IS NULL");

  /** Load req.params.id as an event owned by the current host, or 404. */
  function ownEvent(req, res, next) {
    const event = getOwnEvent.get(Number(req.params.id), req.user.id);
    if (!event) return res.status(404).render('error', { title: 'Not found', message: "We couldn't find that event." });
    req.event = event;
    next();
  }

  function saveTypes(eventId, types) {
    for (const t of types) {
      if (t.remove) {
        if (t.id) deleteType.run(t.id, eventId);
      } else if (t.id) {
        if (updateType.run(t.name, t.price_cents, t.capacity_n, t.id, eventId, t.capacity_n).changes !== 1) {
          throw new Error('Ticket type changed concurrently; please retry.');
        }
      } else {
        insertType.run(eventId, t.name, t.price_cents, t.capacity_n);
      }
    }
  }

  /** Hosts need a connected payout account to sell paid tickets (not with mock payments). */
  function canSellPaid(user) {
    return !payments.requiresHostAccount || Boolean(user.stripe_charges_enabled);
  }

  /** Re-check an unfinished Stripe account so the dashboard reflects onboarding done elsewhere. */
  async function refreshPayoutStatus(user) {
    if (!payments.requiresHostAccount || !user.stripe_account_id || user.stripe_charges_enabled) return;
    try {
      const status = await payments.hostAccounts.status(user.stripe_account_id);
      if (status.chargesEnabled) {
        setChargesEnabled.run(1, user.id);
        user.stripe_charges_enabled = 1;
      }
      user.stripe_details_submitted = status.detailsSubmitted;
    } catch (err) {
      console.error(`Host ${user.id}: could not refresh Stripe account status:`, err.message);
    }
  }

  const PAYOUTS_NEEDED = 'Set up payouts before publishing an event with paid tickets, so ticket money can reach you.';

  router.get('/', async (req, res, next) => {
    try {
      await refreshPayoutStatus(req.user);
      res.render('host/dashboard', { title: 'Host dashboard', events: hostEvents.all(req.user.id), needsPayouts: !canSellPaid(req.user) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/payments', async (req, res, next) => {
    try {
      await refreshPayoutStatus(req.user);
      const summary = await payouts.summary(req.user.id);
      res.render('host/payments', { title: 'Payouts', provider: payments.name, account: req.user, summary });
    } catch (err) {
      next(err);
    }
  });

  async function redirectToOnboarding(req, res) {
    const base = appUrl(req);
    const url = await payments.hostAccounts.onboardingUrl(req.user.stripe_account_id, {
      refreshUrl: `${base}/host/payments/refresh`,
      returnUrl: `${base}/host/payments/return`,
    });
    res.redirect(303, url);
  }

  router.post('/payments/connect', async (req, res, next) => {
    if (!payments.requiresHostAccount) return res.redirect('/host/payments');
    try {
      if (!req.user.stripe_account_id) {
        const accountId = await payments.hostAccounts.create({ email: req.user.email });
        setStripeAccount.run(accountId, req.user.id);
        req.user.stripe_account_id = accountId;
      }
      await redirectToOnboarding(req, res);
    } catch (err) {
      next(err);
    }
  });

  // Stripe sends hosts here when an onboarding link has expired: issue a fresh one.
  router.get('/payments/refresh', async (req, res, next) => {
    if (!payments.requiresHostAccount || !req.user.stripe_account_id) return res.redirect('/host/payments');
    try {
      await redirectToOnboarding(req, res);
    } catch (err) {
      next(err);
    }
  });

  router.get('/payments/return', async (req, res, next) => {
    try {
      await refreshPayoutStatus(req.user);
      if (req.user.stripe_charges_enabled) req.flash('success', "Payouts are set up. You're ready to sell paid tickets.");
      else req.flash('info', 'Stripe still needs a few details before you can take payments. Continue setup when you are ready.');
      res.redirect('/host/payments');
    } catch (err) {
      next(err);
    }
  });

  router.post('/payments/instant', async (req, res, next) => {
    try {
      const { amount, fee } = await payouts.instant(req.user.id);
      req.flash('success', `Instant payout of ${money(amount)} sent (fee ${money(fee)}). It usually arrives within 30 minutes.`);
    } catch (err) {
      if (!(err instanceof PayoutError)) return next(err);
      req.flash('error', err.message);
    }
    res.redirect('/host/payments');
  });

  router.post('/payments/dashboard', async (req, res, next) => {
    if (!payments.requiresHostAccount || !req.user.stripe_account_id) return res.redirect('/host/payments');
    try {
      res.redirect(303, await payments.hostAccounts.dashboardUrl(req.user.stripe_account_id));
    } catch (err) {
      next(err);
    }
  });

  router.get('/events/new', (req, res) => {
    res.render('host/event-form', {
      title: 'New event', event: null, errors: [],
      values: { title: '', description: '', venue: '', starts_at: '', image_url: '' },
      types: [{ id: null, name: 'General admission', price: '', capacity: '', sold: 0 }],
    });
  });

  router.post('/events', (req, res) => {
    const { values, startsAtIso, types, errors } = parseEventForm(req.body);
    if (errors.length) {
      return res.status(400).render('host/event-form', { title: 'New event', event: null, values, types, errors });
    }
    const id = transaction(db, () => {
      const eventId = Number(insertEvent.run(req.user.id, values.title, values.description, values.venue, startsAtIso, values.image_url || null).lastInsertRowid);
      saveTypes(eventId, types);
      return eventId;
    });
    if (req.body.publish !== '1') {
      req.flash('success', 'Draft saved. Publish it when you are ready.');
    } else if (hasPaidTypes.get(id) && !canSellPaid(req.user)) {
      req.flash('error', `Saved as a draft. ${PAYOUTS_NEEDED}`);
      return res.redirect('/host/payments');
    } else {
      setStatus.run('published', id);
      req.flash('success', 'Event published!');
    }
    res.redirect('/host');
  });

  router.get('/events/:id/edit', ownEvent, (req, res) => {
    const e = req.event;
    res.render('host/event-form', {
      title: `Edit ${e.title}`, event: e, errors: [],
      values: { ...e, starts_at: toInputDateTime(e.starts_at), image_url: e.image_url ?? '' },
      types: formTypesFromRows(getTypes.all(e.id)),
    });
  });

  router.post('/events/:id', ownEvent, (req, res) => {
    const e = req.event;
    if (e.status === 'cancelled') {
      req.flash('error', 'Cancelled events cannot be edited.');
      return res.redirect('/host');
    }
    const existing = new Map(getTypes.all(e.id).map((t) => [t.id, t]));
    const { values, startsAtIso, types, errors } = parseEventForm(req.body, existing);
    if (errors.length) {
      return res.status(400).render('host/event-form', { title: `Edit ${e.title}`, event: e, values, types, errors });
    }
    transaction(db, () => {
      updateEvent.run(values.title, values.description, values.venue, startsAtIso, values.image_url || null, e.id);
      saveTypes(e.id, types);
    });
    req.flash('success', 'Event updated.');
    res.redirect('/host');
  });

  router.post('/events/:id/publish', ownEvent, (req, res) => {
    if (req.event.status !== 'draft') {
      req.flash('error', 'Only drafts can be published.');
    } else if (hasPaidTypes.get(req.event.id) && !canSellPaid(req.user)) {
      req.flash('error', PAYOUTS_NEEDED);
      return res.redirect('/host/payments');
    } else {
      setStatus.run('published', req.event.id);
      req.flash('success', `"${req.event.title}" is now live.`);
    }
    res.redirect('/host');
  });

  router.post('/events/:id/cancel', ownEvent, async (req, res, next) => {
    const e = req.event;
    if (e.status === 'cancelled') return res.redirect('/host');
    try {
      setStatus.run('cancelled', e.id);
      let failed = 0;
      for (const order of paidOrders.all(e.id)) {
        let result = { ok: true }; // free orders have nothing to refund
        if (order.total_cents > 0) {
          try {
            result = await payments.refund({ reference: order.payment_reference, amountCents: order.total_cents });
          } catch (err) {
            result = { ok: false, error: err.message };
          }
        }
        if (result.ok) refundOrder.run(order.id);
        else failed++;
      }
      if (failed) req.flash('error', `Event cancelled, but ${failed} refund(s) failed. Please refund those buyers manually.`);
      else req.flash('success', `"${e.title}" was cancelled and all buyers were refunded.`);
      res.redirect('/host');
    } catch (err) {
      next(err);
    }
  });

  router.get('/events/:id/attendees', ownEvent, (req, res) => {
    const list = attendees.all(req.event.id);
    res.render('host/attendees', {
      title: `Attendees · ${req.event.title}`, event: req.event, attendees: list,
      checkedIn: list.filter((a) => a.checked_in_at).length,
    });
  });

  router.post('/events/:id/checkin', ownEvent, (req, res) => {
    const code = String(req.body.code ?? '').trim().toUpperCase();
    const ticket = code && findTicket.get(code, req.event.id);
    if (!ticket) req.flash('error', `No valid ticket with code ${code || '(blank)'} for this event.`);
    else if (checkIn.run(ticket.id).changes === 0) req.flash('error', `Ticket ${code} was already checked in.`);
    else req.flash('success', `Checked in ${ticket.buyer_name} (${ticket.type_name}).`);
    res.redirect(`/host/events/${req.event.id}/attendees`);
  });

  return router;
}
