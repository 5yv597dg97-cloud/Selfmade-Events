// Prices are stored in minor units (pence) and shown in pounds; event times are
// entered and displayed in UK time regardless of the server's timezone.
export const LOCALE = 'en-GB';
export const CURRENCY = 'GBP';
export const TIME_ZONE = 'Europe/London';

const moneyFormat = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY });

/** 1250 -> "£12.50"; 0 -> "Free" unless { free: false }. */
export function money(pence, { free = true } = {}) {
  if (pence === 0 && free) return 'Free';
  return moneyFormat.format(pence / 100);
}

export function dateTime(iso) {
  return new Date(iso).toLocaleString(LOCALE, {
    timeZone: TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

/** Wall-clock parts of a Date in UK time. */
function ukParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
}

/** ISO string -> value for <input type="datetime-local">, in UK time. */
export function toInputDateTime(iso) {
  const p = ukParts(new Date(iso));
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** "2026-11-01T19:00" (UK wall-clock time) -> Date; Invalid Date if malformed. */
export function parseInputDateTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return new Date(NaN);
  const [, y, mo, d, h, mi] = m.map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // Shift by the UK offset (0 in GMT, 1h in BST); repeat once in case the guess crossed a DST change.
  let ts = wall;
  for (let i = 0; i < 2; i++) {
    const p = ukParts(new Date(ts));
    ts = wall - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - ts);
  }
  return new Date(ts);
}

/** "12.50" -> 1250; returns NaN for anything that isn't a non-negative amount. */
export function parseCents(value) {
  const s = String(value ?? '').trim().replace(/^£/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}
