import express, { Router } from 'express';

/**
 * Stripe webhook: the source of truth for whether a checkout was paid.
 * Configure an endpoint for /stripe/webhook in the Stripe dashboard with these events:
 *   checkout.session.completed, checkout.session.async_payment_succeeded,
 *   checkout.session.async_payment_failed, checkout.session.expired
 */
export default function webhookRoutes({ payments, orders }) {
  const router = Router();

  router.post('/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    let event;
    try {
      event = payments.parseWebhook(req.body, req.get('stripe-signature'));
    } catch (err) {
      return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
    }

    try {
      const session = event.data?.object;
      const order = orders.get(Number(session?.metadata?.order_id));
      // Ignore events for sessions this app didn't create (or that don't match the order).
      if (!order || order.checkout_session_id !== session.id) return res.json({ received: true, ignored: true });

      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
          if (session.payment_status === 'paid') {
            const pi = session.payment_intent;
            await orders.fulfil(order.id, typeof pi === 'string' ? pi : pi?.id);
          }
          break;
        case 'checkout.session.expired':
        case 'checkout.session.async_payment_failed':
          orders.release(order.id);
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
