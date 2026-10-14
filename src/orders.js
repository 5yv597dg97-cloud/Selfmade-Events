import crypto from 'node:crypto';
import { transaction } from './db.js';

/**
 * How long seats are held while the buyer is on the payment page. Stripe sessions must
 * last at least 30 minutes from creation; the margin covers request latency.
 */
export const CHECKOUT_HOLD_MS = 32 * 60 * 1000;

export class SoldOutError extends Error {}

/**
 * Order lifecycle: reserve (pending, seats held) -> fulfil (paid) or release (failed, seats freed).
 * Every transition is conditional on the current status, so webhooks, redirects and the
 * background sweep can all report the same outcome safely, in any order.
 */
export function createOrders({ db, payments }) {
  const reserveSeats = db.prepare('UPDATE ticket_types SET sold = sold + ? WHERE id = ? AND event_id = ? AND sold + ? <= capacity');
  const releaseSeats = db.prepare('UPDATE ticket_types SET sold = sold - ? WHERE id = ?');
  const insertOrder = db.prepare(`
    INSERT INTO orders (user_id, event_id, subtotal_cents, booking_fee_cents, commission_cents, total_cents, status, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`);
  const insertTicket = db.prepare('INSERT INTO tickets (order_id, ticket_type_id, code) VALUES (?, ?, ?)');
  const getOrder = db.prepare('SELECT o.*, e.status AS event_status FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = ?');
  const setCheckout = db.prepare('UPDATE orders SET checkout_session_id = ? WHERE id = ?');
  const markPaid = db.prepare("UPDATE orders SET status = 'paid', payment_reference = ? WHERE id = ? AND status = 'pending'");
  const markFailed = db.prepare("UPDATE orders SET status = 'failed' WHERE id = ? AND status = 'pending'");
  const markRefunded = db.prepare("UPDATE orders SET status = 'refunded', payment_reference = ? WHERE id = ?");
  const ticketCounts = db.prepare('SELECT ticket_type_id, COUNT(*) AS n FROM tickets WHERE order_id = ? GROUP BY ticket_type_id');
  const deleteTickets = db.prepare('DELETE FROM tickets WHERE order_id = ?');
  const stalePending = db.prepare("SELECT * FROM orders WHERE status = 'pending' AND expires_at < ?");

  /** Hold seats and create a pending order with its tickets. Throws SoldOutError. */
  function reserve({ userId, eventId, lines, pricing, expiresAt }) {
    return transaction(db, () => {
      for (const { type, qty } of lines) {
        if (reserveSeats.run(qty, type.id, eventId, qty).changes !== 1) throw new SoldOutError(type.name);
      }
      const orderId = Number(insertOrder.run(
        userId, eventId, pricing.subtotal, pricing.bookingFee, pricing.commission, pricing.total, expiresAt.toISOString(),
      ).lastInsertRowid);
      for (const { type, qty } of lines) {
        for (let i = 0; i < qty; i++) insertTicket.run(orderId, type.id, crypto.randomBytes(5).toString('hex').toUpperCase());
      }
      return orderId;
    });
  }

  function attachCheckout(orderId, sessionId) {
    setCheckout.run(sessionId, orderId);
  }

  /** Free the held seats of a pending order. Returns true if this call released it. */
  function release(orderId) {
    return transaction(db, () => {
      if (markFailed.run(orderId).changes !== 1) return false;
      for (const { ticket_type_id, n } of ticketCounts.all(orderId)) releaseSeats.run(n, ticket_type_id);
      deleteTickets.run(orderId);
      return true;
    });
  }

  /**
   * Payment succeeded. Normally marks the order paid; if the order was already released
   * (payment arrived after the hold expired) or the event was cancelled meanwhile, refunds it.
   * Returns the order's resulting status.
   */
  async function fulfil(orderId, reference) {
    markPaid.run(reference, orderId);
    const order = getOrder.get(orderId);
    if (!order) return null;
    if (order.status === 'refunded') return 'refunded';
    if (order.status === 'paid' && order.event_status !== 'cancelled') return 'paid';
    // Money was taken for an order we can't honour: the hold had expired and the seats
    // were released ('failed'), or the event was cancelled while the buyer was paying.
    if (order.total_cents > 0) {
      const result = await payments.refund({ reference, amountCents: order.total_cents });
      if (!result.ok) {
        console.error(`Order ${orderId}: automatic refund of ${reference} failed: ${result.error}`);
        return order.status;
      }
    }
    markRefunded.run(reference, orderId);
    return 'refunded';
  }

  /** Ask the payment provider how a pending order's checkout ended, and settle it. */
  async function settle(order) {
    if (order.status !== 'pending') return order.status;
    if (!order.checkout_session_id) {
      // Never reached the payment page (e.g. the server stopped mid-request).
      if (new Date(order.expires_at) < new Date()) release(order.id);
      return getOrder.get(order.id).status;
    }
    const checkout = await payments.getCheckout(order.checkout_session_id);
    if (checkout.paid) return fulfil(order.id, checkout.reference);
    if (!checkout.open) release(order.id);
    return getOrder.get(order.id).status;
  }

  /** Buyer left the payment page: close the checkout and free the seats (unless they had paid). */
  async function abandon(order) {
    if (order.status !== 'pending') return order.status;
    if (order.checkout_session_id) await payments.expireCheckout(order.checkout_session_id);
    else release(order.id);
    return settle(getOrder.get(order.id));
  }

  /** Settle pending orders whose hold expired (covers missed webhooks). */
  async function sweep() {
    const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    for (const order of stalePending.all(cutoff)) {
      try {
        await settle(order);
      } catch (err) {
        console.error(`Order ${order.id}: sweep failed:`, err.message);
      }
    }
  }

  return { reserve, attachCheckout, release, fulfil, settle, abandon, sweep, get: (id) => getOrder.get(id) };
}
