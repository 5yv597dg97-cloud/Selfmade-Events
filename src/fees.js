/**
 * Platform fees, configured with environment variables (all default to 0):
 *   BOOKING_FEE_PERCENT        % of each paid ticket's price, added to what the buyer pays
 *   BOOKING_FEE_FIXED_PENCE    flat amount per paid ticket, added to what the buyer pays
 *   PLATFORM_COMMISSION_PERCENT  % of ticket sales kept by the platform out of the host's share
 * Free tickets never carry a booking fee.
 */
export function feeConfigFromEnv(env = process.env) {
  const pct = (name) => {
    const n = Number(env[name] ?? 0);
    if (!Number.isFinite(n) || n < 0 || n > 50) throw new Error(`${name} must be a number between 0 and 50`);
    return n;
  };
  const fixed = Number(env.BOOKING_FEE_FIXED_PENCE ?? 0);
  if (!Number.isInteger(fixed) || fixed < 0 || fixed > 10000) throw new Error('BOOKING_FEE_FIXED_PENCE must be a whole number of pence');
  return {
    bookingFeePercent: pct('BOOKING_FEE_PERCENT'),
    bookingFeeFixedPence: fixed,
    commissionPercent: pct('PLATFORM_COMMISSION_PERCENT'),
  };
}

export const NO_FEES = { bookingFeePercent: 0, bookingFeeFixedPence: 0, commissionPercent: 0 };

/** Booking fee charged on one ticket of the given price. */
export function bookingFeeFor(pricePence, fees) {
  if (pricePence === 0) return 0;
  return Math.round((pricePence * fees.bookingFeePercent) / 100) + fees.bookingFeeFixedPence;
}

/**
 * lines: [{ type: { price_cents }, qty }]
 * Returns pence amounts: subtotal (tickets), bookingFee, total (what the buyer pays),
 * commission, applicationFee (platform's share) and hostPayout.
 */
export function priceOrder(lines, fees) {
  let subtotal = 0;
  let bookingFee = 0;
  for (const { type, qty } of lines) {
    subtotal += type.price_cents * qty;
    bookingFee += bookingFeeFor(type.price_cents, fees) * qty;
  }
  const commission = Math.round((subtotal * fees.commissionPercent) / 100);
  return {
    subtotal,
    bookingFee,
    total: subtotal + bookingFee,
    commission,
    applicationFee: bookingFee + commission,
    hostPayout: subtotal - commission,
  };
}
