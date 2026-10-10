import crypto from 'node:crypto';

/**
 * Payment provider interface:
 *   charge({ amountCents, description, orderId }) -> Promise<{ ok, reference?, error? }>
 *   refund({ reference, amountCents })             -> Promise<{ ok, error? }>
 *
 * The mock provider approves everything so the app works end-to-end without
 * credentials. Swap in a real provider (e.g. Stripe) by implementing the same
 * two methods and passing it to createApp({ payments }).
 */
export const mockPayments = {
  async charge({ amountCents }) {
    if (amountCents === 0) return { ok: true, reference: 'free' };
    return { ok: true, reference: `mock_${crypto.randomBytes(8).toString('hex')}` };
  },
  async refund() {
    return { ok: true };
  },
};
