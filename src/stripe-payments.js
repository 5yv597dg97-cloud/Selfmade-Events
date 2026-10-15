import Stripe from 'stripe';

const CURRENCY = 'gbp';

/**
 * Stripe Checkout + Connect. Ticket money goes to the host's connected Express
 * account (a "destination charge"); the platform keeps `application_fee_amount`
 * (booking fee + commission). Stripe's processing fee is taken from the
 * platform's share, so set fees that cover it.
 */
export function createStripePayments({ secretKey, webhookSecret, client = new Stripe(secretKey) }) {
  return {
    name: 'stripe',
    requiresHostAccount: true,

    async startCheckout({ orderId, event, lines, pricing, hostAccountId, buyerEmail, successUrl, cancelUrl, expiresAt }) {
      const lineItems = lines
        .filter(({ type }) => type.price_cents > 0)
        .map(({ type, qty }) => ({
          quantity: qty,
          price_data: { currency: CURRENCY, unit_amount: type.price_cents, product_data: { name: `${event.title} – ${type.name}` } },
        }));
      if (pricing.bookingFee > 0) {
        lineItems.push({ quantity: 1, price_data: { currency: CURRENCY, unit_amount: pricing.bookingFee, product_data: { name: 'Booking fee' } } });
      }
      const metadata = { order_id: String(orderId), event_id: String(event.id) };
      const session = await client.checkout.sessions.create({
        mode: 'payment',
        line_items: lineItems,
        customer_email: buyerEmail,
        client_reference_id: String(orderId),
        metadata,
        payment_intent_data: {
          application_fee_amount: pricing.applicationFee,
          transfer_data: { destination: hostAccountId },
          description: `${event.title} (order #${orderId})`,
          metadata,
        },
        success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: cancelUrl,
        expires_at: Math.floor(expiresAt.getTime() / 1000),
      }, { idempotencyKey: `checkout-order-${orderId}` });
      return { status: 'redirect', url: session.url, sessionId: session.id };
    },

    async getCheckout(sessionId) {
      const s = await client.checkout.sessions.retrieve(sessionId);
      const pi = s.payment_intent;
      return {
        paid: s.status === 'complete' && s.payment_status === 'paid',
        // Still undecided: the buyer is on the page, or a delayed payment method
        // (e.g. a bank debit) completed checkout but hasn't cleared yet.
        open: s.status === 'open' || (s.status === 'complete' && s.payment_status === 'unpaid'),
        reference: typeof pi === 'string' ? pi : pi?.id ?? null,
      };
    },

    async expireCheckout(sessionId) {
      try {
        await client.checkout.sessions.expire(sessionId);
      } catch (err) {
        // Already expired or completed; the caller re-checks the session state.
        if (err?.type !== 'StripeInvalidRequestError') throw err;
      }
    },

    async refund({ reference }) {
      try {
        // Pull the money back from the host and return the platform's fee too: a full refund to the buyer.
        await client.refunds.create({ payment_intent: reference, reverse_transfer: true, refund_application_fee: true });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    /** A payment to the platform itself (e.g. a host featuring an event): no transfer, no application fee. */
    async startPlatformCheckout({ key, name, amountCents, buyerEmail, metadata, successUrl, cancelUrl, expiresAt }) {
      const session = await client.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ quantity: 1, price_data: { currency: CURRENCY, unit_amount: amountCents, product_data: { name } } }],
        customer_email: buyerEmail,
        client_reference_id: key,
        metadata,
        payment_intent_data: { description: name, metadata },
        success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: cancelUrl,
        expires_at: Math.floor(expiresAt.getTime() / 1000),
      }, { idempotencyKey: `checkout-${key}` });
      return { status: 'redirect', url: session.url, sessionId: session.id };
    },

    async refundPlatformCharge({ reference }) {
      try {
        await client.refunds.create({ payment_intent: reference });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    parseWebhook(rawBody, signature) {
      if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
      return client.webhooks.constructEvent(rawBody, signature, webhookSecret);
    },

    hostAccounts: {
      async create({ email }) {
        const account = await client.accounts.create({
          type: 'express',
          country: 'GB',
          email,
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          business_profile: { product_description: 'Tickets for events I host' },
        });
        return account.id;
      },
      async onboardingUrl(accountId, { refreshUrl, returnUrl }) {
        const link = await client.accountLinks.create({ account: accountId, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding' });
        return link.url;
      },
      async status(accountId) {
        const a = await client.accounts.retrieve(accountId);
        return { chargesEnabled: Boolean(a.charges_enabled), detailsSubmitted: Boolean(a.details_submitted) };
      },
      async dashboardUrl(accountId) {
        return (await client.accounts.createLoginLink(accountId)).url;
      },
    },
  };
}
