// Removing the bookmaker's margin ("vig") from a set of decimal odds to recover
// the probabilities the market actually believes. Every method returns
// probabilities that sum to 1, in the same order as the input odds.

/** Raw implied probabilities 1/odds; these sum to more than 1 (the overround). */
export function implied(odds) {
  return odds.map((o) => 1 / o);
}

export function overround(odds) {
  return implied(odds).reduce((a, b) => a + b, 0) - 1;
}

/** Scales each implied probability by the same factor. Simple but overrates longshots. */
export function multiplicative(odds) {
  const q = implied(odds);
  const sum = q.reduce((a, b) => a + b, 0);
  return q.map((x) => x / sum);
}

/**
 * Finds k so that sum(q_i^k) = 1. Takes more margin off longshots than
 * favourites, matching how books actually shade prices (favourite-longshot bias).
 */
export function power(odds) {
  const q = implied(odds);
  const total = (k) => q.reduce((a, x) => a + x ** k, 0);
  const k = bisect((k) => total(k) - 1, 1, 10);
  return q.map((x) => x ** k);
}

/**
 * Shin (1993): models the margin as protection against insider bettors, with z
 * the share of insider money. Like power, it pushes margin onto longshots.
 */
export function shin(odds) {
  const q = implied(odds);
  const s = q.reduce((a, b) => a + b, 0);
  const probs = (z) => q.map((x) => (Math.sqrt(z * z + (4 * (1 - z) * x * x) / s) - z) / (2 * (1 - z)));
  const z = bisect((z) => probs(z).reduce((a, b) => a + b, 0) - 1, 0, 0.5);
  return probs(z);
}

export const METHODS = { multiplicative, power, shin };

export function devig(odds, method = 'power') {
  if (odds.length < 2 || odds.some((o) => !(o > 1))) throw new Error(`Can't devig odds ${odds}`);
  const fn = METHODS[method];
  if (!fn) throw new Error(`Unknown devig method "${method}" (use ${Object.keys(METHODS).join(', ')})`);
  // A book priced under 100% (arb or exchange quirk) has no margin to remove.
  if (overround(odds) <= 0) return multiplicative(odds);
  return fn(odds);
}

/** Root of a decreasing-or-increasing f on [lo, hi] where f(lo) and f(hi) differ in sign. */
function bisect(f, lo, hi) {
  let flo = f(lo);
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const fmid = f(mid);
    if (Math.abs(fmid) < 1e-12) return mid;
    if (Math.sign(fmid) === Math.sign(flo)) { lo = mid; flo = fmid; } else hi = mid;
  }
  return (lo + hi) / 2;
}
