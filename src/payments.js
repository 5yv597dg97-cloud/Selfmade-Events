import crypto from 'node:crypto';
import { createStripePayments } from './stripe-payments.js';

/**
 * Payment provider interface:
 *   name                      'mock' | 'stripe'
 *   requiresHostAccount       hosts must connect a payout account before selling paid tickets
 *   startCheckout(opts)    -> { status: 'paid', reference }               (paid immediately), or
 *                             { status: 'redirect', url, sessionId }      (send the buyer to a hosted page)
 *     opts: { orderId, event, lines, pricing, hostAccountId, buyerEmail, successUrl, cancelUrl, expiresAt }
 *   getCheckout(sessionId) -> { paid, open, reference }   (open: outcome not decided yet)
 *   expireCheckout(sessionId)
 *   refund({ reference, amountCents }) -> { ok, error? }
 *   parseWebhook(rawBody, signature) -> event   (throws if the signature is invalid)
 *   hostAccounts               when requiresHostAccount: { create, onboardingUrl, status, dashboardUrl,
 *                              balance, payout, collectFee, returnFee }
 */

/** Approves everything instantly, so the app works end-to-end without credentials (development and tests). */
export const mockPayments = {
  name: 'mock',
  requiresHostAccount: false,
  async startCheckout() {
    return { status: 'paid', reference: `mock_${crypto.randomBytes(8).toString('hex')}` };
  },
  async getCheckout() {
    return { paid: false, open: false, reference: null };
  },
  async expireCheckout() {},
  async refund() {
    return { ok: true };
  },
  parseWebhook() {
    throw new Error('Webhooks are not used with mock payments');
  },
};

/**
 * Stripe when STRIPE_SECRET_KEY is set; otherwise mock payments, which production
 * refuses unless PAYMENTS=mock is set explicitly (so nobody gets free tickets by accident).
 */
export function paymentsFromEnv(env = process.env) {
  if (env.STRIPE_SECRET_KEY) {
    if (!env.STRIPE_WEBHOOK_SECRET) {
      // Allowed so the first deploy works (the webhook needs the site's URL to exist first).
      // Payments are still confirmed when buyers return from Stripe and by the background sweep.
      console.warn('STRIPE_WEBHOOK_SECRET is not set: Stripe webhooks will be rejected until it is.');
    }
    return createStripePayments({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET });
  }
  if (env.NODE_ENV === 'production' && env.PAYMENTS !== 'mock') {
    throw new Error('STRIPE_SECRET_KEY is not set. Add your Stripe keys, or set PAYMENTS=mock to run a demo without real payments.');
  }
  return mockPayments;
}
