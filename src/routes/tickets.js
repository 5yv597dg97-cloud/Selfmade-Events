import { Router } from 'express';
import { requireLogin } from '../middleware.js';

export default function ticketRoutes({ db }) {
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
    const orders = myOrders.all(req.user.id).map((o) => ({ ...o, tickets: orderTickets.all(o.id) }));
    res.render('my-tickets', { title: 'My tickets', orders });
  });

  return router;
}
