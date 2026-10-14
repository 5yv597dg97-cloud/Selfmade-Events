// Display helpers shared by the CLI and the Telegram bot.
export const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
export const money = (x) => gbp.format(x);
export const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;
export const when = (iso) => new Date(iso).toLocaleString('en-GB', {
  timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

/** Calendar date in UK time, for "per day" limits. */
export const ukDate = (d) => new Date(d).toLocaleDateString('en-GB', { timeZone: 'Europe/London' });

export function selection(p) {
  if (p.market === 'h2h') return p.outcome === 'Draw' ? 'Draw' : `${p.outcome} to win`;
  const pt = p.point > 0 && p.market === 'spreads' ? `+${p.point}` : p.point;
  return `${p.outcome} ${pt}`;
}
