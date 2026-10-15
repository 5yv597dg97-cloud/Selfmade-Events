/**
 * Platform fees, configured with environment variables:
 *   BOOKING_FEE_PERCENT        % of each paid ticket's price, added to what the buyer pays (default 0)
 *   BOOKING_FEE_FIXED_PENCE    flat amount per paid ticket, added to what the buyer pays (default 0)
 *   PLATFORM_COMMISSION_PERCENT  % of ticket sales kept by the platform out of the host's share (default 0)
 *   FEATURED_PRICE_PER_DAY_PENCE  what hosts pay per day to feature an event on the homepage
 *                                 (default 200; 0 turns featuring off)
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
  const featured = Number(env.FEATURED_PRICE_PER_DAY_PENCE ?? 200);
  // Stripe's smallest GBP charge is 30p.
  if (!Number.isInteger(featured) || (featured !== 0 && featured < 30) || featured > 100000) {
    throw new Error('FEATURED_PRICE_PER_DAY_PENCE must be 0 (off) or a whole number of pence from 30 to 100000');
  }
  return {
    bookingFeePercent: pct('BOOKING_FEE_PERCENT'),
    bookingFeeFixedPence: fixed,
    commissionPercent: pct('PLATFORM_COMMISSION_PERCENT'),
    featuredDayPence: featured,
  };
}

export const NO_FEES = { bookingFeePercent: 0, bookingFeeFixedPence: 0, commissionPercent: 0, featuredDayPence: 0 };

/**
 * Stripe's fee for a standard UK card payment, used for profit estimates only.
 * With destination charges this comes out of the platform's share. EEA and
 * international cards cost more (up to 3.25% + 20p).
 */
export const CARD_FEE_ESTIMATE = { percent: 1.5, fixedPence: 20 };

/** SQL for the estimated card fee on a pence column; bind cardFeeParams ($pct, $fixed) with it. */
export const cardFeeSql = (column) => `CASE WHEN ${column} > 0 THEN CAST(ROUND(${column} * $pct / 100.0) AS INTEGER) + $fixed ELSE 0 END`;
export const cardFeeParams = { pct: CARD_FEE_ESTIMATE.percent, fixed: CARD_FEE_ESTIMATE.fixedPence };

export function estimateCardFee(amountPence) {
  if (amountPence <= 0) return 0;
  return Math.round((amountPence * CARD_FEE_ESTIMATE.percent) / 100) + CARD_FEE_ESTIMATE.fixedPence;
}

/** What one ticket at this price earns everyone, after the estimated card fee. */
export function exampleSale(fees, pricePence = 1000) {
  const p = priceOrder([{ type: { price_cents: pricePence }, qty: 1 }], fees);
  const cardFee = estimateCardFee(p.total);
  return {
    price: pricePence,
    bookingFee: p.bookingFee,
    buyerPays: p.total,
    commission: p.commission,
    platformFee: p.applicationFee,
    cardFee,
    net: p.applicationFee - cardFee,
    hostGets: p.hostPayout,
  };
}

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
