// Stake sizing. Full Kelly maximises long-run bankroll growth but swings wildly
// and punishes any error in the probability estimate, so we bet a fraction of it
// and cap any single bet.

/** Expected profit per unit staked at decimal odds `odds` if the true probability is `p`. */
export function expectedValue(p, odds) {
  return p * odds - 1;
}

/** Full-Kelly fraction of bankroll; 0 when the bet has no edge. */
export function kellyFraction(p, odds) {
  const f = (p * odds - 1) / (odds - 1);
  return Math.max(0, f);
}

/** Expected log growth of the bankroll from betting fraction f. */
export function logGrowth(p, odds, f) {
  if (f <= 0) return 0;
  return p * Math.log(1 + f * (odds - 1)) + (1 - p) * Math.log(1 - f);
}

/** Stake in pounds, rounded down to the penny. */
export function stake({ p, odds, bankroll, fraction, maxStakePct }) {
  const f = Math.min(kellyFraction(p, odds) * fraction, maxStakePct);
  return { f, amount: Math.floor(bankroll * f * 100 + 1e-9) / 100 };
}
