import { test } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { createStripePayments } from '../src/stripe-payments.js';
import { paymentsFromEnv, mockPayments } from '../src/payments.js';
import { priceOrder, feeConfigFromEnv } from '../src/fees.js';

/** Records calls made to the Stripe client. */
function stubClient() {
  const calls = [];
  const rec = (name, result) => async (...args) => {
    calls.push({ name, args });
    return typeof result === 'function' ? result(...args) : result;
  };
  return {
    calls,
    checkout: {
      sessions: {
        create: rec('sessions.create', { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }),
        retrieve: rec('sessions.retrieve', { status: 'complete', payment_status: 'paid', payment_intent: 'pi_1' }),
        expire: rec('sessions.expire', () => {
          const err = new Error('Only open sessions can be expired');
          err.type = 'StripeInvalidRequestError';
          throw err;
        }),
      },
    },
    refunds: { create: rec('refunds.create', { id: 're_1' }) },
    accounts: {
      create: rec('accounts.create', { id: 'acct_1' }),
      retrieve: rec('accounts.retrieve', { charges_enabled: true, details_submitted: true }),
      createLoginLink: rec('accounts.createLoginLink', { url: 'https://connect.stripe.com/express/x' }),
    },
    accountLinks: { create: rec('accountLinks.create', { url: 'https://connect.stripe.com/setup/x' }) },
    balance: {
      retrieve: rec('balance.retrieve', {
        available: [{ currency: 'gbp', amount: 5000 }, { currency: 'eur', amount: 999 }],
        instant_available: [{ currency: 'gbp', amount: 4000 }],
      }),
    },
    payouts: { create: rec('payouts.create', { id: 'po_1', arrival_date: 1792000000 }) },
    charges: { create: rec('charges.create', { id: 'py_1' }) },
    transfers: { create: rec('transfers.create', { id: 'tr_1' }) },
    webhooks: new Stripe('sk_test_dummy').webhooks,
  };
}

test('checkout session charges in GBP, adds the booking fee and routes funds to the host', async () => {
  const client = stubClient();
  const stripe = createStripePayments({ webhookSecret: 'whsec_x', client });
  const fees = { bookingFeePercent: 5, bookingFeeFixedPence: 30, commissionPercent: 10 };
  const lines = [{ type: { id: 1, name: 'GA', price_cents: 2000 }, qty: 2 }, { type: { id: 2, name: 'Free', price_cents: 0 }, qty: 1 }];
  const pricing = priceOrder(lines, fees);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  const result = await stripe.startCheckout({
    orderId: 7, event: { id: 3, title: 'Jazz Night' }, lines, pricing, hostAccountId: 'acct_host',
    buyerEmail: 'amy@example.co.uk', successUrl: 'https://site/orders/7/success', cancelUrl: 'https://site/orders/7/cancel', expiresAt,
  });
  assert.deepEqual(result, { status: 'redirect', url: 'https://checkout.stripe.com/c/pay/cs_1', sessionId: 'cs_1' });

  const [params, options] = client.calls[0].args;
  assert.equal(params.mode, 'payment');
  assert.deepEqual(params.line_items, [
    { quantity: 2, price_data: { currency: 'gbp', unit_amount: 2000, product_data: { name: 'Jazz Night – GA' } } },
    { quantity: 1, price_data: { currency: 'gbp', unit_amount: 260, product_data: { name: 'Booking fee' } } },
  ]);
  assert.equal(params.payment_intent_data.application_fee_amount, 260 + 400);
  assert.deepEqual(params.payment_intent_data.transfer_data, { destination: 'acct_host' });
  assert.equal(params.metadata.order_id, '7');
  assert.equal(params.success_url, 'https://site/orders/7/success?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(params.expires_at, Math.floor(expiresAt.getTime() / 1000));
  assert.equal(options.idempotencyKey, 'checkout-order-7');
});

test('refunds reverse the host transfer and the platform fee', async () => {
  const client = stubClient();
  const stripe = createStripePayments({ webhookSecret: 'whsec_x', client });
  assert.deepEqual(await stripe.refund({ reference: 'pi_1', amountCents: 100 }), { ok: true });
  assert.deepEqual(client.calls[0].args[0], { payment_intent: 'pi_1', reverse_transfer: true, refund_application_fee: true });
});

test('session lookup, expiry of a finished session, and host accounts', async () => {
  const client = stubClient();
  const stripe = createStripePayments({ webhookSecret: 'whsec_x', client });
  assert.deepEqual(await stripe.getCheckout('cs_1'), { paid: true, open: false, reference: 'pi_1' });
  await stripe.expireCheckout('cs_1'); // already complete: swallowed

  // A delayed payment method that hasn't cleared counts as still open, so its seats stay held.
  client.checkout.sessions.retrieve = async () => ({ status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_2' });
  assert.deepEqual(await stripe.getCheckout('cs_2'), { paid: false, open: true, reference: 'pi_2' });

  assert.equal(await stripe.hostAccounts.create({ email: 'host@example.co.uk' }), 'acct_1');
  const accountParams = client.calls.find((c) => c.name === 'accounts.create').args[0];
  assert.equal(accountParams.type, 'express');
  assert.equal(accountParams.country, 'GB');
  assert.deepEqual(await stripe.hostAccounts.status('acct_1'), { chargesEnabled: true, detailsSubmitted: true });
  assert.equal(await stripe.hostAccounts.onboardingUrl('acct_1', { refreshUrl: 'r', returnUrl: 'u' }), 'https://connect.stripe.com/setup/x');
});

test('webhook signatures are verified with the signing secret', () => {
  const secret = 'whsec_test_secret';
  const stripe = createStripePayments({ webhookSecret: secret, client: stubClient() });
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });
  const header = new Stripe('sk_test_dummy').webhooks.generateTestHeaderString({ payload, secret });
  assert.equal(stripe.parseWebhook(Buffer.from(payload), header).id, 'evt_1');
  const forged = new Stripe('sk_test_dummy').webhooks.generateTestHeaderString({ payload, secret: 'whsec_wrong' });
  assert.throws(() => stripe.parseWebhook(Buffer.from(payload), forged));
});

test('production refuses to start without Stripe keys unless demo mode is explicit', () => {
  assert.equal(paymentsFromEnv({}), mockPayments);
  assert.throws(() => paymentsFromEnv({ NODE_ENV: 'production' }), /STRIPE_SECRET_KEY/);
  assert.equal(paymentsFromEnv({ NODE_ENV: 'production', PAYMENTS: 'mock' }), mockPayments);
  const noWebhook = paymentsFromEnv({ STRIPE_SECRET_KEY: 'sk_test_x' });
  assert.equal(noWebhook.name, 'stripe');
  assert.throws(() => noWebhook.parseWebhook(Buffer.from('{}'), 't=1,v1=x'), /not configured/);
  assert.equal(paymentsFromEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }).name, 'stripe');
});

test('fee configuration from environment', () => {
  assert.deepEqual(feeConfigFromEnv({}), { bookingFeePercent: 0, bookingFeeFixedPence: 0, commissionPercent: 0 });
  assert.deepEqual(
    feeConfigFromEnv({ BOOKING_FEE_PERCENT: '2.5', BOOKING_FEE_FIXED_PENCE: '49', PLATFORM_COMMISSION_PERCENT: '5' }),
    { bookingFeePercent: 2.5, bookingFeeFixedPence: 49, commissionPercent: 5 },
  );
  assert.throws(() => feeConfigFromEnv({ BOOKING_FEE_PERCENT: 'lots' }));
  assert.throws(() => feeConfigFromEnv({ BOOKING_FEE_FIXED_PENCE: '0.5' }));
});

test('free tickets carry no booking fee', () => {
  const p = priceOrder([{ type: { price_cents: 0 }, qty: 3 }], { bookingFeePercent: 5, bookingFeeFixedPence: 30, commissionPercent: 10 });
  assert.deepEqual(p, { subtotal: 0, bookingFee: 0, total: 0, commission: 0, applicationFee: 0, hostPayout: 0 });
});

test('host payouts: manual schedule, balance in pence, payouts and fees on the host account', async () => {
  const client = stubClient();
  const stripe = createStripePayments({ webhookSecret: 'whsec_x', client });
  const call = (name) => client.calls.find((c) => c.name === name).args;

  await stripe.hostAccounts.create({ email: 'host@example.co.uk' });
  assert.deepEqual(call('accounts.create')[0].settings, { payouts: { schedule: { interval: 'manual' } } });

  assert.deepEqual(await stripe.hostAccounts.balance('acct_1'), { available: 5000, instantAvailable: 4000 });
  assert.deepEqual(call('balance.retrieve')[1], { stripeAccount: 'acct_1' });

  const payout = await stripe.hostAccounts.payout('acct_1', { amount: 3900, method: 'instant', idempotencyKey: 'k1', description: 'd' });
  assert.equal(payout.id, 'po_1');
  assert.deepEqual(call('payouts.create'), [
    { amount: 3900, currency: 'gbp', method: 'instant', description: 'd' },
    { stripeAccount: 'acct_1', idempotencyKey: 'k1' },
  ]);

  await stripe.hostAccounts.collectFee('acct_1', { amount: 40, idempotencyKey: 'k2', description: 'Instant payout fee' });
  assert.deepEqual(call('charges.create')[0], { amount: 40, currency: 'gbp', source: 'acct_1', description: 'Instant payout fee' });

  await stripe.hostAccounts.returnFee('acct_1', { amount: 40, idempotencyKey: 'k3' });
  assert.equal(call('transfers.create')[0].destination, 'acct_1');
});
