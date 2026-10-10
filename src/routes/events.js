import { Router } from 'express';
import crypto from 'node:crypto';
import { transaction } from '../db.js';
import { requireLogin } from '../middleware.js';

export const MAX_TICKETS_PER_TYPE = 10;

class SoldOutError extends Error {}

export default function eventRoutes({ db, payments }) {
  const router = Router();

  const listUpcoming = db.prepare(`
    SELECT e.*, u.name AS host_name,
           MIN(t.price_cents) AS min_price,
           COALESCE(SUM(t.capacity - t.sold), 0) AS remaining
    FROM events e
    JOIN users u ON u.id = e.host_id
    LEFT JOIN ticket_types t ON t.event_id = e.id
    WHERE e.status = 'published' AND e.starts_at >= ?
      AND (? = '' OR e.title LIKE ? OR e.venue LIKE ? OR e.description LIKE ?)
    GROUP BY e.id
    ORDER BY e.starts_at
    LIMIT 100`);
  const getEvent = db.prepare(`
    SELECT e.*, u.name AS host_name FROM events e JOIN users u ON u.id = e.host_id WHERE e.id = ?`);
  const getTypes = db.prepare('SELECT * FROM ticket_types WHERE event_id = ? ORDER BY price_cents, id');
  const reserve = db.prepare('UPDATE ticket_types SET sold = sold + ? WHERE id = ? AND event_id = ? AND sold + ? <= capacity');
  const release = db.prepare('UPDATE ticket_types SET sold = sold - ? WHERE id = ?');
  const insertOrder = db.prepare("INSERT INTO orders (user_id, event_id, total_cents, status) VALUES (?, ?, ?, 'pending')");
  const insertTicket = db.prepare('INSERT INTO tickets (order_id, ticket_type_id, code) VALUES (?, ?, ?)');
  const setOrderStatus = db.prepare('UPDATE orders SET status = ?, payment_reference = ? WHERE id = ?');
  const deleteTickets = db.prepare('DELETE FROM tickets WHERE order_id = ?');

  /** An event is visible to the public once published (or cancelled, so buyers see the notice). */
  function isVisible(event, user) {
    return event && (event.status !== 'draft' || event.host_id === user?.id);
  }

  router.get('/', (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    const like = `%${q}%`;
    const events = listUpcoming.all(new Date().toISOString(), q, like, like, like);
    res.render('events/index', { title: 'Upcoming events', events, q });
  });

  router.get('/events/:id', (req, res, next) => {
    const event = getEvent.get(Number(req.params.id));
    if (!isVisible(event, req.user)) return next();
    res.render('events/show', { title: event.title, event, types: getTypes.all(event.id), max: MAX_TICKETS_PER_TYPE });
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
    const total = lines.reduce((sum, l) => sum + l.qty * l.type.price_cents, 0);

    // 1. Reserve seats and create a pending order atomically.
    let orderId;
    try {
      orderId = transaction(db, () => {
        for (const { type, qty } of lines) {
          if (reserve.run(qty, type.id, event.id, qty).changes !== 1) throw new SoldOutError(type.name);
        }
        const id = Number(insertOrder.run(req.user.id, event.id, total).lastInsertRowid);
        for (const { type, qty } of lines) {
          for (let i = 0; i < qty; i++) insertTicket.run(id, type.id, crypto.randomBytes(5).toString('hex').toUpperCase());
        }
        return id;
      });
    } catch (err) {
      if (err instanceof SoldOutError) {
        req.flash('error', `Not enough "${err.message}" tickets left. Please choose fewer.`);
        return res.redirect(back);
      }
      return next(err);
    }

    // 2. Take payment outside the transaction; release the seats if it fails.
    let result;
    try {
      result = await payments.charge({ amountCents: total, description: event.title, orderId });
    } catch (err) {
      result = { ok: false, error: err.message };
    }

    if (!result.ok) {
      transaction(db, () => {
        for (const { type, qty } of lines) release.run(qty, type.id);
        deleteTickets.run(orderId);
        setOrderStatus.run('failed', null, orderId);
      });
      req.flash('error', `Payment failed${result.error ? `: ${result.error}` : ''}. You have not been charged.`);
      return res.redirect(back);
    }

    setOrderStatus.run('paid', result.reference, orderId);
    req.flash('success', 'Your tickets are booked!');
    res.redirect(`/my-tickets#order-${orderId}`);
  });

  return router;
}
