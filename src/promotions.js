import { transaction } from './db.js';
import { CHECKOUT_HOLD_MS } from './orders.js';

/** How many days a host can feature an event for. */
export const FEATURE_DAY_OPTIONS = [1, 3, 7, 14];
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Featured listings: a host pays the platform to show an event at the top of the
 * homepage for a number of days. Lifecycle mirrors orders: pending -> paid (the
 * featured period starts) or failed; a payment that can't be honoured (the event was
 * cancelled or has started meanwhile) is refunded. Buying again extends the period.
 */
export function createPromotions({ db, payments, alert = async () => {} }) {
  const insert = db.prepare(`
    INSERT INTO promotions (event_id, host_id, days, amount_cents, status, expires_at)
    VALUES (?, ?, ?, ?, 'pending', ?)`);
  const getPromotion = db.prepare(`
    SELECT p.*, e.status AS event_status, e.starts_at AS event_starts_at
    FROM promotions p JOIN events e ON e.id = p.event_id WHERE p.id = ?`);
  const latestEnd = db.prepare("SELECT MAX(ends_at) AS ends_at FROM promotions WHERE event_id = ? AND status = 'paid'");
  const setCheckout = db.prepare('UPDATE promotions SET checkout_session_id = ? WHERE id = ?');
  // A late payment for a released ('failed') checkout is still honoured: nothing scarce was given up.
  const markPaid = db.prepare(`
    UPDATE promotions SET status = 'paid', payment_reference = ?, starts_at = ?, ends_at = ?
    WHERE id = ? AND status IN ('pending', 'failed')`);
  const markFailed = db.prepare("UPDATE promotions SET status = 'failed' WHERE id = ? AND status = 'pending'");
  const markRefunded = db.prepare(`
    UPDATE promotions SET status = 'refunded', payment_reference = ? WHERE id = ? AND status IN ('pending', 'failed')`);
  const stalePending = db.prepare("SELECT * FROM promotions WHERE status = 'pending' AND expires_at < ?");

  /** End of the event's current featured period, if it is featured now. */
  function featuredUntil(eventId, now = new Date()) {
    const { ends_at: end } = latestEnd.get(eventId);
    return end && new Date(end) > now ? new Date(end) : null;
  }

  /**
   * Day options still worth buying: a new period starts when the current one ends, and
   * must start before the event does. A part-day counts as a day.
   */
  function dayOptions(event, now = new Date()) {
    const start = featuredUntil(event.id, now) ?? now;
    const daysLeft = Math.ceil((new Date(event.starts_at) - start) / DAY_MS);
    return FEATURE_DAY_OPTIONS.filter((d) => d <= daysLeft);
  }

  function create({ event, hostId, days, amountCents }) {
    const expiresAt = new Date(Date.now() + CHECKOUT_HOLD_MS);
    const id = Number(insert.run(event.id, hostId, days, amountCents, expiresAt.toISOString()).lastInsertRowid);
    return { id, expiresAt };
  }

  function attachCheckout(id, sessionId) {
    setCheckout.run(sessionId, id);
  }

  /** Give up on an unpaid checkout. Returns true if this call released it. */
  function release(id) {
    return markFailed.run(id).changes === 1;
  }

  /**
   * Payment succeeded: start the featured period. If none of it can run (the event was
   * cancelled, has started, or is already featured until it starts), refund instead.
   */
  async function fulfil(id, reference) {
    const promo = getPromotion.get(id);
    if (!promo) return null;
    if (promo.status === 'paid' || promo.status === 'refunded') return promo.status;
    const now = new Date();
    const started = transaction(db, () => {
      const start = featuredUntil(promo.event_id, now) ?? now;
      if (promo.event_status !== 'published' || start >= new Date(promo.event_starts_at)) return false;
      const end = new Date(start.getTime() + promo.days * DAY_MS);
      markPaid.run(reference, start.toISOString(), end.toISOString(), id);
      return true;
    });
    if (started) return getPromotion.get(id).status;
    if (promo.amount_cents > 0) {
      const result = await payments.refundPlatformCharge({ reference });
      if (!result.ok) {
        console.error(`Promotion ${id}: automatic refund of ${reference} failed: ${result.error}`);
        void alert(`A host paid to feature an event that can no longer be featured, and the automatic refund failed (${result.error}). Refund payment ${reference} in Stripe.`);
        return promo.status;
      }
    }
    markRefunded.run(reference, id);
    return 'refunded';
  }

  /** Ask the payment provider how a pending checkout ended, and settle it. */
  async function settle(promo) {
    if (promo.status !== 'pending') return promo.status;
    if (!promo.checkout_session_id) {
      if (new Date(promo.expires_at) < new Date()) release(promo.id);
      return getPromotion.get(promo.id).status;
    }
    const checkout = await payments.getCheckout(promo.checkout_session_id);
    if (checkout.paid) return fulfil(promo.id, checkout.reference);
    if (!checkout.open) release(promo.id);
    return getPromotion.get(promo.id).status;
  }

  /** Host left the payment page: close the checkout (unless they had paid). */
  async function abandon(promo) {
    if (promo.status !== 'pending') return promo.status;
    if (promo.checkout_session_id) await payments.expireCheckout(promo.checkout_session_id);
    else release(promo.id);
    return settle(getPromotion.get(promo.id));
  }

  /** Settle pending checkouts whose time ran out (covers missed webhooks). */
  async function sweep() {
    const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    for (const promo of stalePending.all(cutoff)) {
      try {
        await settle(promo);
      } catch (err) {
        console.error(`Promotion ${promo.id}: sweep failed:`, err.message);
      }
    }
  }

  return {
    create, attachCheckout, release, fulfil, settle, abandon, sweep, featuredUntil, dayOptions,
    get: (id) => getPromotion.get(id),
  };
}
