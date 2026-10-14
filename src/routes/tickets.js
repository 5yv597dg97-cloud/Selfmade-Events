import { Router } from 'express';
import { requireLogin } from '../middleware.js';

export default function ticketRoutes({ db, orders }) {
  const router = Router();

  const myOrders = db.prepare(`
    SELECT o.*, e.title, e.venue, e.starts_at, e.status AS event_status
    FROM orders o JOIN events e ON e.id = o.event_id
    WHERE o.user_id = ? AND o.status IN ('paid', 'refunded')
    ORDER BY e.starts_at DESC, o.id DESC`);
  const orderTickets = db.prepare(`
    SELECT t.code, t.checked_in_at, tt.name AS type_name
    FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id
    WHERE t.order_id = ? ORDER BY t.id`);

  router.get('/my-tickets', requireLogin, (req, res) => {
    const list = myOrders.all(req.user.id).map((o) => ({ ...o, tickets: orderTickets.all(o.id) }));
    res.render('my-tickets', { title: 'My tickets', orders: list });
  });

  /** Load req.params.id as one of the current user's orders, or 404. */
  function ownOrder(req, res, next) {
    const order = orders.get(Number(req.params.id));
    if (!order || order.user_id !== req.user.id) {
      return res.status(404).render('error', { title: 'Not found', message: "We couldn't find that order." });
    }
    req.order = order;
    next();
  }

  // Stripe sends the buyer here after paying. The webhook normally confirms the order
  // first; checking the session here too means the page is right even if it's late.
  router.get('/orders/:id/success', requireLogin, ownOrder, async (req, res, next) => {
    try {
      const status = await orders.settle(req.order);
      if (status === 'paid') {
        req.flash('success', 'Payment received. Your tickets are booked!');
      } else if (status === 'pending') {
        req.flash('info', "We're confirming your payment. Your tickets will appear here in a moment; refresh to check.");
      } else if (status === 'refunded') {
        req.flash('error', 'Sorry, your booking could not be completed, so your payment has been refunded in full.');
      } else {
        req.flash('error', 'Your payment did not go through, so no tickets were booked.');
        return res.redirect(`/events/${req.order.event_id}`);
      }
      res.redirect(`/my-tickets#order-${req.order.id}`);
    } catch (err) {
      next(err);
    }
  });

  // Buyer pressed "back" on the payment page: free their seats right away.
  router.get('/orders/:id/cancel', requireLogin, ownOrder, async (req, res, next) => {
    try {
      const status = await orders.abandon(req.order);
      if (status === 'paid') {
        req.flash('success', 'Payment received. Your tickets are booked!');
        return res.redirect(`/my-tickets#order-${req.order.id}`);
      }
      if (req.order.status === 'pending') req.flash('info', 'Checkout cancelled. You have not been charged.');
      res.redirect(`/events/${req.order.event_id}`);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
