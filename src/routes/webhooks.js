import express, { Router } from 'express';

/**
 * Stripe webhook: the source of truth for whether a checkout was paid.
 * Configure an endpoint for /stripe/webhook in the Stripe dashboard with these events:
 *   checkout.session.completed, checkout.session.async_payment_succeeded,
 *   checkout.session.async_payment_failed, checkout.session.expired,
 *   and (for the owner's Telegram alerts) charge.dispute.created, charge.dispute.closed
 */
export default function webhookRoutes({ payments, orders, promotions, assistant }) {
  const router = Router();

  router.post('/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    let event;
    try {
      event = payments.parseWebhook(req.body, req.get('stripe-signature'));
    } catch (err) {
      return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
    }

    if (event.type === 'charge.dispute.created' || event.type === 'charge.dispute.closed') {
      void assistant.paymentDisputed(event);
      return res.json({ received: true });
    }

    try {
      const session = event.data?.object;
      const metadata = session?.metadata ?? {};
      // A checkout pays for either a ticket order or a featured listing; both settle the same way.
      const flow = metadata.promotion_id ? promotions : orders;
      const record = flow.get(Number(metadata.promotion_id ?? metadata.order_id));
      // Ignore events for sessions this app didn't create (or that don't match the record).
      if (!record || record.checkout_session_id !== session.id) return res.json({ received: true, ignored: true });

      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
          if (session.payment_status === 'paid') {
            const pi = session.payment_intent;
            await flow.fulfil(record.id, typeof pi === 'string' ? pi : pi?.id);
          }
          break;
        case 'checkout.session.expired':
        case 'checkout.session.async_payment_failed':
          flow.release(record.id);
          break;
        default:
          break;
      }
      res.json({ received: true });
    } catch (err) {
      console.error(`Webhook ${event.id} (${event.type}) failed:`, err);
      res.status(500).send('Webhook handling failed'); // Stripe retries
    }
  });

  return router;
}
