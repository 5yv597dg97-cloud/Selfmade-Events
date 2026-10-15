// Grading finished bets from a final score. Quarter handicaps/totals (e.g. -0.75)
// are split into two half-stakes on the neighbouring half lines.

/** Margin by which the bet beat its line: >0 won, <0 lost, 0 push. */
function margin(bet, homeScore, awayScore, point) {
  const isHome = bet.outcome === bet.home;
  if (bet.market === 'totals') {
    const total = homeScore + awayScore;
    return bet.outcome === 'Over' ? total - point : point - total;
  }
  const diff = isHome ? homeScore - awayScore : awayScore - homeScore;
  if (bet.market === 'spreads') return diff + point;
  if (bet.market === 'h2h') {
    if (bet.outcome === 'Draw') return homeScore === awayScore ? 1 : -1;
    return diff === 0 ? -1 : diff; // a draw loses a three-way win bet
  }
  throw new Error(`Can't grade market ${bet.market}`);
}

const unitReturn = (m, odds) => (m > 0 ? odds - 1 : m < 0 ? -1 : 0);

/** Returns { status, pnl } for a bet given the final score. */
export function grade(bet, homeScore, awayScore) {
  const point = bet.point ?? 0;
  const quarter = bet.market !== 'h2h' && Math.abs((point * 4) % 2) === 1;
  const r = quarter
    ? (unitReturn(margin(bet, homeScore, awayScore, point - 0.25), bet.odds)
      + unitReturn(margin(bet, homeScore, awayScore, point + 0.25), bet.odds)) / 2
    : unitReturn(margin(bet, homeScore, awayScore, point), bet.odds);
  const pnl = Math.round(r * bet.stake * 100) / 100;
  const status = r === 0 ? 'push' : r === -1 ? 'lost' : r === bet.odds - 1 ? 'won' : r > 0 ? 'half-won' : 'half-lost';
  return { status, pnl };
}

/**
 * A double's result once its legs are known: lost as soon as any leg loses;
 * otherwise, once every leg is decided, paid at the odds of the legs that won
 * (a void leg counts as odds of 1, as bookmakers settle it). Null while pending.
 */
export function doubleOutcome(double) {
  const { legs, stake } = double;
  if (legs.some((l) => l.result === 'lost')) return { status: 'lost', pnl: -stake };
  if (!legs.every((l) => l.result)) return null;
  if (legs.every((l) => l.result === 'void')) return { status: 'void', pnl: 0 };
  const odds = legs.reduce((a, l) => a * (l.result === 'won' ? l.odds : 1), 1);
  return { status: 'won', pnl: Math.round(stake * (odds - 1) * 100) / 100 };
}

/** Manual result: won, lost, push/void, half-won, half-lost. */
export function manualResult(bet, status) {
  const r = { won: bet.odds - 1, lost: -1, push: 0, void: 0, 'half-won': (bet.odds - 1) / 2, 'half-lost': -0.5 }[status];
  if (r === undefined) throw new Error('Result must be won, lost, push, void, half-won or half-lost');
  return { status, pnl: Math.round(r * bet.stake * 100) / 100 };
}
