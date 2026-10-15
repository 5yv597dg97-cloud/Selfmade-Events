import { cardFeeSql, cardFeeParams } from '../fees.js';
import { parseInputDateTime, toInputDateTime, dateTime } from '../format.js';

/**
 * Read-only business figures for the owner's assistant. Every query is fixed here
 * (the model never writes SQL), and none of them return buyers' personal details,
 * passwords or sessions. Hosts' names and emails are included so the owner can
 * contact them.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const gbp = (pence) => Math.round(pence) / 100;

/** Thrown for bad tool input; the message goes back to the model. */
export class ToolInputError extends Error {}

/** UK calendar date (YYYY-MM-DD) of a moment. */
export function ukDate(date) {
  return toInputDateTime(date.toISOString()).slice(0, 10);
}

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Midnight UK time at the start of a calendar date. */
export function ukMidnight(ymd) {
  return parseInputDateTime(`${ymd}T00:00`);
}

/** "2026-10-05" -> "Mon 5 Oct". */
export function shortDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
}

/** Monday (UK date) of the week containing `date`. */
export function mondayOf(date) {
  const ymd = ukDate(date);
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(ymd, -((dow + 6) % 7));
}

function checkDate(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value);
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new ToolInputError(`${name} must be a date like 2026-10-31`);
  return s;
}

/** A UK-date range, inclusive of both ends, as UTC instants [from, to). */
function period(input, now, defaultDays) {
  const end = checkDate(input.end_date, 'end_date') ?? ukDate(now);
  const start = checkDate(input.start_date, 'start_date') ?? addDays(end, -(defaultDays - 1));
  if (start > end) throw new ToolInputError('start_date must be on or before end_date');
  if ((Date.parse(end) - Date.parse(start)) / DAY_MS > 3660) throw new ToolInputError('Ask for ten years or less at a time');
  return { start, end, from: ukMidnight(start).toISOString(), to: ukMidnight(addDays(end, 1)).toISOString() };
}

function oneOf(value, allowed, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) throw new ToolInputError(`${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

function limitOf(value, fallback = 20) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new ToolInputError('limit must be a whole number from 1 to 50');
  return n;
}

const sellThrough = (sold, capacity) => (capacity > 0 ? Math.round((sold / capacity) * 100) : null);

/** The tools the assistant may call. All read-only. */
export const TOOLS = [
  {
    name: 'get_business_summary',
    description: 'Totals for a date range: your income (booking fees, commission, featured listings), estimated Stripe card fees and profit, ticket sales, tickets sold, paid orders, refunds, and new hosts, buyers and events. Dates are UK calendar dates, both ends included. Defaults to the last 7 days including today.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'First day, YYYY-MM-DD' },
        end_date: { type: 'string', description: 'Last day, YYYY-MM-DD (default today)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_sales_over_time',
    description: 'Paid orders, ticket sales and your income per day, week (starting Monday) or month, for trends and comparisons. Default range: 30 days by day, 12 weeks by week, 12 months by month.',
    input_schema: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: ['day', 'week', 'month'] },
        start_date: { type: 'string', description: 'First day, YYYY-MM-DD' },
        end_date: { type: 'string', description: 'Last day, YYYY-MM-DD (default today)' },
      },
      required: ['group_by'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_events',
    description: 'Events with their host, date, status, tickets sold against capacity, ticket sales, your fees and whether they are featured. "sold" includes seats held by buyers who are paying right now.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['upcoming', 'past', 'draft', 'cancelled', 'all'], description: 'Default upcoming (published, not started)' },
        sort: { type: 'string', enum: ['date', 'best_selling', 'slowest_selling', 'newest'], description: 'Default date. slowest_selling = lowest % of capacity sold first' },
        limit: { type: 'integer', description: '1-50, default 20' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_event_details',
    description: 'One event in full: description, ticket types with prices and sales, orders, refunds, check-ins, featured periods and host contact details.',
    input_schema: {
      type: 'object',
      properties: { event_id: { type: 'integer' } },
      required: ['event_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_hosts',
    description: 'Hosts with their contact email, join date, whether they can take payments, event counts, tickets sold, ticket sales, the fees you earned from them and what they spent on featured listings.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['all', 'no_upcoming_events', 'never_published', 'payouts_unfinished'], description: 'Default all' },
        sort: { type: 'string', enum: ['ticket_sales', 'newest'], description: 'Default ticket_sales' },
        limit: { type: 'integer', description: '1-50, default 20' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_attention_items',
    description: 'Things that need the owner now: hosts who have not finished payout setup, old drafts, events starting soon that are selling slowly, buyers on cancelled events still waiting for refunds, and checkouts stuck in payment.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export function createBusinessData({ db, fees, payments }) {
  const statements = new Map();
  /** Run a fixed query, binding only the named parameters it uses. */
  function query(sql, params = {}, method = 'all') {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    const used = Object.fromEntries(Object.entries(params).filter(([key]) => sql.includes(`$${key}`)));
    return statements.get(sql)[method](used);
  }
  const realPayments = payments.requiresHostAccount;
  const inPeriod = (column) => `${column} >= datetime($from) AND ${column} < datetime($to)`;

  function summary(input = {}, now = new Date()) {
    const p = period(input, now, 7);
    const params = { from: p.from, to: p.to, ...cardFeeParams };
    const o = query(`
      SELECT
        COALESCE(SUM(status = 'paid'), 0) AS paid_orders,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN subtotal_cents END), 0) AS sales,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN booking_fee_cents END), 0) AS booking_fees,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN commission_cents END), 0) AS commission,
        COALESCE(SUM(status = 'refunded'), 0) AS refunded_orders,
        COALESCE(SUM(CASE WHEN status = 'refunded' THEN total_cents END), 0) AS refunded,
        COALESCE(SUM(${cardFeeSql('total_cents')}), 0) AS card_fees
      FROM orders WHERE status IN ('paid', 'refunded') AND ${inPeriod('created_at')}`, params, 'get');
    const tickets = query(`
      SELECT COUNT(*) AS n FROM tickets t JOIN orders o ON o.id = t.order_id
      WHERE o.status = 'paid' AND ${inPeriod('o.created_at')}`, params, 'get').n;
    const promo = query(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents END), 0) AS featured,
        COALESCE(SUM(status = 'paid'), 0) AS featured_purchases,
        COALESCE(SUM(${cardFeeSql('amount_cents')}), 0) AS card_fees
      FROM promotions WHERE status IN ('paid', 'refunded') AND ${inPeriod('created_at')}`, params, 'get');
    const people = query(`
      SELECT COALESCE(SUM(role = 'host'), 0) AS hosts, COALESCE(SUM(role = 'client'), 0) AS buyers
      FROM users WHERE ${inPeriod('created_at')}`, params, 'get');
    const events = query(`SELECT COUNT(*) AS n FROM events WHERE ${inPeriod('created_at')}`, params, 'get').n;

    const income = o.booking_fees + o.commission + promo.featured;
    const cardFees = o.card_fees + promo.card_fees;
    return {
      period: `${p.start} to ${p.end}`,
      income_gbp: gbp(income),
      income_breakdown_gbp: { booking_fees: gbp(o.booking_fees), commission: gbp(o.commission), featured_listings: gbp(promo.featured) },
      estimated_card_fees_gbp: gbp(cardFees),
      estimated_profit_gbp: gbp(income - cardFees),
      ticket_sales_gbp: gbp(o.sales),
      tickets_sold: tickets,
      paid_orders: o.paid_orders,
      featured_purchases: promo.featured_purchases,
      refunds: { orders: o.refunded_orders, amount_gbp: gbp(o.refunded) },
      new_hosts: people.hosts,
      new_buyer_accounts: people.buyers,
      events_created: events,
    };
  }

  function salesOverTime(input = {}, now = new Date()) {
    const groupBy = oneOf(input.group_by, ['day', 'week', 'month'], 'group_by', 'day');
    const p = period(input, now, { day: 30, week: 84, month: 365 }[groupBy]);
    // Grouped on UTC timestamps, so an order just after midnight in summer can land on the previous day.
    const bucket = {
      day: (c) => `date(${c})`,
      week: (c) => `date(${c}, '-6 days', 'weekday 1')`,
      month: (c) => `strftime('%Y-%m', ${c})`,
    }[groupBy];
    const params = { from: p.from, to: p.to };
    const rows = new Map();
    const row = (key) => {
      if (!rows.has(key)) rows.set(key, { period: key, paid_orders: 0, ticket_sales_gbp: 0, income_gbp: 0 });
      return rows.get(key);
    };
    for (const r of query(`
      SELECT ${bucket('created_at')} AS k, COUNT(*) AS orders, SUM(subtotal_cents) AS sales,
        SUM(booking_fee_cents + commission_cents) AS fees
      FROM orders WHERE status = 'paid' AND ${inPeriod('created_at')} GROUP BY k`, params)) {
      Object.assign(row(r.k), { paid_orders: r.orders, ticket_sales_gbp: gbp(r.sales) });
      row(r.k).income_gbp += gbp(r.fees);
    }
    for (const r of query(`
      SELECT ${bucket('created_at')} AS k, SUM(amount_cents) AS featured
      FROM promotions WHERE status = 'paid' AND ${inPeriod('created_at')} GROUP BY k`, params)) {
      row(r.k).income_gbp = gbp(Math.round(row(r.k).income_gbp * 100) + r.featured);
    }
    return {
      period: `${p.start} to ${p.end}`,
      group_by: groupBy === 'week' ? 'week starting Monday' : groupBy,
      rows: [...rows.values()].sort((a, b) => a.period.localeCompare(b.period)),
      note: 'Periods with no sales are left out.',
    };
  }

  const EVENT_COLUMNS = `
    e.id, e.title, e.venue, e.starts_at, e.status, e.created_at, u.name AS host,
    COALESCE((SELECT SUM(capacity) FROM ticket_types WHERE event_id = e.id), 0) AS capacity,
    COALESCE((SELECT SUM(sold) FROM ticket_types WHERE event_id = e.id), 0) AS sold,
    COALESCE((SELECT SUM(subtotal_cents) FROM orders WHERE event_id = e.id AND status = 'paid'), 0) AS sales,
    COALESCE((SELECT SUM(booking_fee_cents + commission_cents) FROM orders WHERE event_id = e.id AND status = 'paid'), 0) AS fees,
    (SELECT MAX(ends_at) FROM promotions WHERE event_id = e.id AND status = 'paid') AS featured_until`;

  function eventRow(e, now) {
    return {
      id: e.id,
      title: e.title,
      host: e.host,
      venue: e.venue,
      starts: dateTime(e.starts_at),
      status: e.status === 'published' ? (new Date(e.starts_at) < now ? 'finished' : 'on sale') : e.status,
      tickets_sold: e.sold,
      capacity: e.capacity,
      sell_through_pct: sellThrough(e.sold, e.capacity),
      ticket_sales_gbp: gbp(e.sales),
      your_fees_gbp: gbp(e.fees),
      featured_until: e.featured_until && new Date(e.featured_until) > now && e.status === 'published' ? dateTime(e.featured_until) : null,
      created: ukDate(new Date(`${e.created_at.replace(' ', 'T')}Z`)),
    };
  }

  function listEvents(input = {}, now = new Date()) {
    const status = oneOf(input.status, ['upcoming', 'past', 'draft', 'cancelled', 'all'], 'status', 'upcoming');
    const sort = oneOf(input.sort, ['date', 'best_selling', 'slowest_selling', 'newest'], 'sort', 'date');
    const where = {
      upcoming: "e.status = 'published' AND e.starts_at >= $now",
      past: "e.status = 'published' AND e.starts_at < $now",
      draft: "e.status = 'draft'",
      cancelled: "e.status = 'cancelled'",
      all: '1 = 1',
    }[status];
    const order = {
      date: ['upcoming', 'draft'].includes(status) ? 'e.starts_at ASC' : 'e.starts_at DESC',
      best_selling: 'sold DESC, sales DESC',
      slowest_selling: 'CAST(sold AS REAL) / MAX(capacity, 1) ASC, e.starts_at ASC',
      newest: 'e.created_at DESC, e.id DESC',
    }[sort];
    const rows = query(`
      SELECT ${EVENT_COLUMNS} FROM events e JOIN users u ON u.id = e.host_id
      WHERE ${where} ORDER BY ${order} LIMIT $limit`, { now: now.toISOString(), limit: limitOf(input.limit) });
    return { status, sort, events: rows.map((e) => eventRow(e, now)) };
  }

  function eventDetails(input = {}, now = new Date()) {
    const id = Number(input.event_id);
    if (!Number.isInteger(id)) throw new ToolInputError('event_id must be a whole number');
    const e = query(`
      SELECT ${EVENT_COLUMNS}, e.description, u.email AS host_email
      FROM events e JOIN users u ON u.id = e.host_id WHERE e.id = $id`, { id }, 'get');
    if (!e) throw new ToolInputError(`There is no event with id ${id}`);
    const types = query('SELECT name, price_cents, capacity, sold FROM ticket_types WHERE event_id = $id ORDER BY price_cents, id', { id });
    const orders = query(`
      SELECT COALESCE(SUM(status = 'paid'), 0) AS paid, COALESCE(SUM(status = 'refunded'), 0) AS refunded,
        COALESCE(SUM(CASE WHEN status = 'refunded' THEN total_cents END), 0) AS refunded_amount
      FROM orders WHERE event_id = $id`, { id }, 'get');
    const checkedIn = query(`
      SELECT COUNT(*) AS n FROM tickets t JOIN orders o ON o.id = t.order_id
      WHERE o.event_id = $id AND o.status = 'paid' AND t.checked_in_at IS NOT NULL`, { id }, 'get').n;
    const featured = query(`
      SELECT days, amount_cents, starts_at, ends_at FROM promotions
      WHERE event_id = $id AND status = 'paid' ORDER BY starts_at`, { id });
    return {
      ...eventRow(e, now),
      host_email: e.host_email,
      description: e.description.length > 1500 ? `${e.description.slice(0, 1500)}…` : e.description,
      ticket_types: types.map((t) => ({ name: t.name, price_gbp: gbp(t.price_cents), sold: t.sold, capacity: t.capacity })),
      paid_orders: orders.paid,
      refunded_orders: orders.refunded,
      refunded_gbp: gbp(orders.refunded_amount),
      tickets_checked_in: checkedIn,
      featured_periods: featured.map((f) => ({ days: f.days, paid_gbp: gbp(f.amount_cents), from: dateTime(f.starts_at), until: dateTime(f.ends_at) })),
    };
  }

  function listHosts(input = {}, now = new Date()) {
    const filter = oneOf(input.filter, ['all', 'no_upcoming_events', 'never_published', 'payouts_unfinished'], 'filter', 'all');
    const sort = oneOf(input.sort, ['ticket_sales', 'newest'], 'sort', 'ticket_sales');
    if (filter === 'payouts_unfinished' && !realPayments) {
      throw new ToolInputError('Payments are in demo mode, so hosts do not need to set up payouts.');
    }
    const where = {
      all: '1 = 1',
      no_upcoming_events: 'upcoming = 0',
      never_published: 'published = 0',
      payouts_unfinished: 'u.stripe_charges_enabled = 0',
    }[filter];
    const order = { ticket_sales: 'sales DESC, tickets DESC, u.id', newest: 'u.created_at DESC, u.id DESC' }[sort];
    const rows = query(`
      SELECT * FROM (
        SELECT u.id, u.name, u.email, u.created_at, u.stripe_account_id, u.stripe_charges_enabled,
          (SELECT COUNT(*) FROM events WHERE host_id = u.id AND status = 'published') AS published,
          (SELECT COUNT(*) FROM events WHERE host_id = u.id AND status = 'draft') AS drafts,
          (SELECT COUNT(*) FROM events WHERE host_id = u.id AND status = 'published' AND starts_at >= $now) AS upcoming,
          (SELECT COUNT(*) FROM tickets t JOIN orders o ON o.id = t.order_id JOIN events e ON e.id = o.event_id
            WHERE e.host_id = u.id AND o.status = 'paid') AS tickets,
          COALESCE((SELECT SUM(o.subtotal_cents) FROM orders o JOIN events e ON e.id = o.event_id
            WHERE e.host_id = u.id AND o.status = 'paid'), 0) AS sales,
          COALESCE((SELECT SUM(o.booking_fee_cents + o.commission_cents) FROM orders o JOIN events e ON e.id = o.event_id
            WHERE e.host_id = u.id AND o.status = 'paid'), 0) AS fees,
          COALESCE((SELECT SUM(amount_cents) FROM promotions WHERE host_id = u.id AND status = 'paid'), 0) AS featured_spend
        FROM users u WHERE u.role = 'host'
      ) u WHERE ${where} ORDER BY ${order} LIMIT $limit`, { now: now.toISOString(), limit: limitOf(input.limit) });
    return {
      filter,
      hosts: rows.map((h) => ({
        id: h.id,
        name: h.name,
        email: h.email,
        joined: ukDate(new Date(`${h.created_at.replace(' ', 'T')}Z`)),
        can_take_payments: realPayments ? Boolean(h.stripe_charges_enabled) : 'not needed in demo mode',
        payout_setup_started: realPayments ? Boolean(h.stripe_account_id) : undefined,
        published_events: h.published,
        upcoming_events: h.upcoming,
        draft_events: h.drafts,
        tickets_sold: h.tickets,
        ticket_sales_gbp: gbp(h.sales),
        your_fees_gbp: gbp(h.fees),
        featured_spend_gbp: gbp(h.featured_spend),
      })),
    };
  }

  function attentionItems(_input = {}, now = new Date()) {
    const nowIso = now.toISOString();
    const payoutsUnfinished = realPayments ? query(`
      SELECT u.name, u.email,
        (SELECT COUNT(*) FROM events e WHERE e.host_id = u.id AND e.status = 'draft'
          AND EXISTS (SELECT 1 FROM ticket_types t WHERE t.event_id = e.id AND t.price_cents > 0)) AS paid_drafts
      FROM users u
      WHERE u.role = 'host' AND u.stripe_charges_enabled = 0
        AND (u.stripe_account_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM events e JOIN ticket_types t ON t.event_id = e.id
          WHERE e.host_id = u.id AND e.status = 'draft' AND t.price_cents > 0))
      ORDER BY u.created_at DESC LIMIT 10`) : [];
    const staleDrafts = query(`
      SELECT e.id, e.title, e.starts_at, e.created_at, u.name AS host, u.email AS host_email
      FROM events e JOIN users u ON u.id = e.host_id
      WHERE e.status = 'draft' AND e.starts_at >= $now AND e.created_at < datetime($cutoff)
      ORDER BY e.starts_at LIMIT 10`, { now: nowIso, cutoff: new Date(now - 3 * DAY_MS).toISOString() });
    const slow = query(`
      SELECT ${EVENT_COLUMNS} FROM events e JOIN users u ON u.id = e.host_id
      WHERE e.status = 'published' AND e.starts_at >= $now AND e.starts_at < $soon
      ORDER BY e.starts_at`, { now: nowIso, soon: new Date(now.getTime() + 14 * DAY_MS).toISOString() })
      .filter((e) => e.capacity > 0 && e.sold / e.capacity < 0.3)
      .slice(0, 10);
    const owed = query(`
      SELECT e.id, e.title, COUNT(*) AS orders, SUM(o.total_cents) AS amount
      FROM orders o JOIN events e ON e.id = o.event_id
      WHERE e.status = 'cancelled' AND o.status = 'paid' AND o.total_cents > 0
      GROUP BY e.id ORDER BY amount DESC LIMIT 10`);
    const stuck = query(`
      SELECT (SELECT COUNT(*) FROM orders WHERE status = 'pending' AND expires_at < $cutoff)
           + (SELECT COUNT(*) FROM promotions WHERE status = 'pending' AND expires_at < $cutoff) AS n`,
    { cutoff: new Date(now - 60 * 60 * 1000).toISOString() }, 'get').n;

    return {
      hosts_who_have_not_finished_payout_setup: payoutsUnfinished.map((h) => ({ name: h.name, email: h.email, paid_drafts_waiting: h.paid_drafts })),
      drafts_older_than_3_days: staleDrafts.map((e) => ({ id: e.id, title: e.title, host: e.host, host_email: e.host_email, starts: dateTime(e.starts_at) })),
      slow_selling_events_in_next_14_days: slow.map((e) => eventRow(e, now)),
      cancelled_events_with_buyers_still_owed_refunds: owed.map((r) => ({ id: r.id, title: r.title, orders: r.orders, amount_gbp: gbp(r.amount) })),
      checkouts_stuck_over_an_hour: stuck,
    };
  }

  /** Figures for the Monday report: last week (Mon-Sun, UK) against the week before. */
  function weeklyDigest(now = new Date()) {
    const thisMonday = mondayOf(now);
    const lastWeek = { start_date: addDays(thisMonday, -7), end_date: addDays(thisMonday, -1) };
    const weekBefore = { start_date: addDays(thisMonday, -14), end_date: addDays(thisMonday, -8) };
    const nowIso = now.toISOString();
    const lastWeekPeriod = period(lastWeek, now, 7);
    const comingUp = query(`
      SELECT ${EVENT_COLUMNS} FROM events e JOIN users u ON u.id = e.host_id
      WHERE e.status = 'published' AND e.starts_at >= $now AND e.starts_at < $soon
      ORDER BY e.starts_at LIMIT 8`, { now: nowIso, soon: new Date(now.getTime() + 7 * DAY_MS).toISOString() });
    const top = query(`
      SELECT e.id, e.title, u.name AS host, SUM(o.subtotal_cents) AS sales, SUM(o.booking_fee_cents + o.commission_cents) AS fees,
        COUNT(*) AS orders
      FROM orders o JOIN events e ON e.id = o.event_id JOIN users u ON u.id = e.host_id
      WHERE o.status = 'paid' AND ${inPeriod('o.created_at')}
      GROUP BY e.id ORDER BY fees DESC, sales DESC LIMIT 5`, { from: lastWeekPeriod.from, to: lastWeekPeriod.to });
    return {
      week: lastWeek,
      last_week: summary(lastWeek, now),
      week_before: summary(weekBefore, now),
      top_events_last_week: top.map((t) => ({ id: t.id, title: t.title, host: t.host, orders: t.orders, ticket_sales_gbp: gbp(t.sales), your_fees_gbp: gbp(t.fees) })),
      coming_up_next_7_days: comingUp.map((e) => eventRow(e, now)),
      needs_attention: attentionItems({}, now),
      live_events: query("SELECT COUNT(*) AS n FROM events WHERE status = 'published' AND starts_at >= $now", { now: nowIso }, 'get').n,
      prices: {
        booking_fee: `${fees.bookingFeePercent}% + ${fees.bookingFeeFixedPence}p per paid ticket`,
        commission: `${fees.commissionPercent}%`,
        featured_per_day_gbp: gbp(fees.featuredDayPence),
      },
      payments: realPayments ? 'Stripe (real money)' : 'demo mode (no real money)',
    };
  }

  /** What the event screen sees: the listing and some context about its host, no contact details. */
  function eventForScreening(eventId) {
    const e = query(`
      SELECT e.id, e.title, e.description, e.venue, e.starts_at, e.image_url, u.created_at AS host_joined,
        (SELECT COUNT(*) FROM events WHERE host_id = e.host_id) AS host_event_count
      FROM events e JOIN users u ON u.id = e.host_id WHERE e.id = $id`, { id: eventId }, 'get');
    if (!e) return null;
    const types = query('SELECT name, price_cents, capacity FROM ticket_types WHERE event_id = $id ORDER BY price_cents, id', { id: eventId });
    return {
      title: e.title,
      description: e.description,
      venue: e.venue,
      starts: dateTime(e.starts_at),
      has_image: Boolean(e.image_url),
      ticket_types: types.map((t) => ({ name: t.name, price_gbp: gbp(t.price_cents), capacity: t.capacity })),
      host_account_age_days: Math.floor((Date.now() - Date.parse(`${e.host_joined.replace(' ', 'T')}Z`)) / DAY_MS),
      host_total_events: e.host_event_count,
    };
  }

  /** Owner-facing facts for alerts about an event. */
  function eventContact(eventId) {
    return query(`
      SELECT e.id, e.title, u.name AS host, u.email AS host_email
      FROM events e JOIN users u ON u.id = e.host_id WHERE e.id = $id`, { id: eventId }, 'get') ?? null;
  }

  /** Which order or featured listing a Stripe payment belongs to (for dispute alerts). */
  function paymentContext(paymentIntentId) {
    if (!paymentIntentId) return null;
    const order = query(`
      SELECT o.id, e.title, u.name AS host FROM orders o JOIN events e ON e.id = o.event_id JOIN users u ON u.id = e.host_id
      WHERE o.payment_reference = $ref`, { ref: paymentIntentId }, 'get');
    if (order) return `order #${order.id} for "${order.title}" (host: ${order.host})`;
    const promo = query(`
      SELECT p.id, e.title, u.name AS host FROM promotions p JOIN events e ON e.id = p.event_id JOIN users u ON u.id = p.host_id
      WHERE p.payment_reference = $ref`, { ref: paymentIntentId }, 'get');
    if (promo) return `a featured listing for "${promo.title}" (host: ${promo.host})`;
    return null;
  }

  const handlers = {
    get_business_summary: summary,
    get_sales_over_time: salesOverTime,
    list_events: listEvents,
    get_event_details: eventDetails,
    list_hosts: listHosts,
    get_attention_items: attentionItems,
  };

  /** Run a tool for the model. Returns tool_result fields: { content, is_error? }. */
  function runTool(name, input, now = new Date()) {
    const handler = handlers[name];
    if (!handler) return { content: `Unknown tool ${name}`, is_error: true };
    try {
      return { content: JSON.stringify(handler(input ?? {}, now)) };
    } catch (err) {
      if (err instanceof ToolInputError) return { content: err.message, is_error: true };
      console.error(`Assistant tool ${name} failed:`, err);
      return { content: 'That lookup failed because of a server error.', is_error: true };
    }
  }

  return {
    summary, salesOverTime, listEvents, eventDetails, listHosts, attentionItems, weeklyDigest,
    eventForScreening, eventContact, paymentContext, runTool,
  };
}
