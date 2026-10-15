import { Router } from 'express';
import { requireAdmin } from '../middleware.js';
import { CARD_FEE_ESTIMATE, cardFeeSql, cardFeeParams, exampleSale } from '../fees.js';

/**
 * The site owner's earnings: what the platform keeps (booking fees, commission and
 * featured listings), minus an estimate of Stripe's card fees, which come out of the
 * platform's share. Months are calendar months in UTC.
 */
export default function adminRoutes({ db, payments, fees }) {
  const router = Router();
  router.use(requireAdmin);

  // Refunded payments still cost the card fee: Stripe keeps it when money is returned.
  const orderMonths = db.prepare(`
    SELECT strftime('%Y-%m', created_at) AS month,
      SUM(status = 'paid') AS orders,
      SUM(CASE WHEN status = 'paid' THEN subtotal_cents ELSE 0 END) AS sales,
      SUM(CASE WHEN status = 'paid' THEN booking_fee_cents ELSE 0 END) AS booking_fees,
      SUM(CASE WHEN status = 'paid' THEN commission_cents ELSE 0 END) AS commission,
      SUM(${cardFeeSql('total_cents')}) AS card_fees
    FROM orders WHERE status IN ('paid', 'refunded') GROUP BY month`);
  const ticketMonths = db.prepare(`
    SELECT strftime('%Y-%m', o.created_at) AS month, COUNT(*) AS tickets
    FROM tickets t JOIN orders o ON o.id = t.order_id WHERE o.status = 'paid' GROUP BY month`);
  const promotionMonths = db.prepare(`
    SELECT strftime('%Y-%m', created_at) AS month,
      SUM(CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END) AS featured,
      SUM(${cardFeeSql('amount_cents')}) AS card_fees
    FROM promotions WHERE status IN ('paid', 'refunded') GROUP BY month`);
  const topEvents = db.prepare(`
    SELECT e.id, e.title, e.starts_at, e.status, u.name AS host_name,
      COUNT(*) AS orders, SUM(o.subtotal_cents) AS sales, SUM(o.booking_fee_cents + o.commission_cents) AS fees
    FROM orders o JOIN events e ON e.id = o.event_id JOIN users u ON u.id = e.host_id
    WHERE o.status = 'paid'
    GROUP BY e.id ORDER BY fees DESC, sales DESC LIMIT 10`);
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'host') AS hosts,
      (SELECT COUNT(*) FROM users WHERE role = 'host' AND stripe_charges_enabled = 1) AS hosts_with_payouts,
      (SELECT COUNT(*) FROM users WHERE role = 'client') AS buyers,
      (SELECT COUNT(*) FROM events WHERE status = 'published' AND starts_at >= $now) AS live_events,
      (SELECT COUNT(DISTINCT event_id) FROM promotions WHERE status = 'paid' AND starts_at <= $now AND ends_at > $now) AS featured_now`);

  function monthlyTotals() {
    const months = new Map();
    const row = (month) => {
      if (!months.has(month)) {
        months.set(month, { month, orders: 0, tickets: 0, sales: 0, bookingFees: 0, commission: 0, featured: 0, cardFees: 0 });
      }
      return months.get(month);
    };
    for (const r of orderMonths.all(cardFeeParams)) {
      Object.assign(row(r.month), { orders: r.orders, sales: r.sales, bookingFees: r.booking_fees, commission: r.commission });
      row(r.month).cardFees += r.card_fees;
    }
    for (const r of ticketMonths.all()) row(r.month).tickets = r.tickets;
    for (const r of promotionMonths.all(cardFeeParams)) {
      row(r.month).featured = r.featured;
      row(r.month).cardFees += r.card_fees;
    }
    for (const m of months.values()) {
      m.income = m.bookingFees + m.commission + m.featured;
      m.profit = m.income - m.cardFees;
    }
    return [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
  }

  router.get('/', (req, res) => {
    const months = monthlyTotals();
    const thisMonth = new Date().toISOString().slice(0, 7);
    const sum = (key) => months.reduce((total, m) => total + m[key], 0);
    const allTime = Object.fromEntries(['orders', 'tickets', 'sales', 'bookingFees', 'commission', 'featured', 'cardFees', 'income', 'profit']
      .map((key) => [key, sum(key)]));
    const current = months.find((m) => m.month === thisMonth)
      ?? { month: thisMonth, orders: 0, tickets: 0, sales: 0, bookingFees: 0, commission: 0, featured: 0, cardFees: 0, income: 0, profit: 0 };
    res.render('admin/earnings', {
      title: 'Earnings',
      current,
      allTime,
      months: months.slice(0, 12),
      topEvents: topEvents.all(),
      counts: counts.get({ now: new Date().toISOString() }),
      fees,
      examples: [1000, 2500].map((price) => exampleSale(fees, price)),
      cardFeeEstimate: CARD_FEE_ESTIMATE,
      provider: payments.name,
    });
  });

  return router;
}
