import Anthropic from '@anthropic-ai/sdk';
import { createTelegram } from './telegram.js';
import { createBusinessData, mondayOf, shortDate } from './data.js';
import { createBrain, RefusalError } from './brain.js';
import { dateTime, money, parseInputDateTime } from '../format.js';

/**
 * The owner's private business assistant on Telegram:
 * - answers questions about the business from live, read-only figures (needs ANTHROPIC_API_KEY);
 * - sends a report every Monday from 8am UK time (figures always; suggestions with the API key);
 * - alerts the owner to failed refunds, payment disputes and risky-looking new events.
 * Only the chat in TELEGRAM_ASSISTANT_CHAT_ID is answered; everyone else is ignored.
 */

const CONVERSATION_IDLE_MS = 30 * 60 * 1000; // after this, a message starts a new conversation
const MAX_CONVERSATION_MESSAGES = 60;
const REPORT_CHECK_MS = 10 * 60 * 1000;
const REPORT_STATE_KEY = 'weekly_report_sent_at';

const HELP = `I'm your Selfmade Events assistant. Ask me anything about the business, for example:
• How did we do this week?
• Which events are selling slowest?
• Which hosts haven't published anything?
• Compare this month with last month

Commands:
/report  the weekly report, now
/new  start a fresh conversation

I also message you every Monday morning with the weekly report, and straight away if a refund fails, a buyer disputes a payment, or a new event looks risky. I can only read figures: I can't change anything on the site.`;

/** Used when the assistant isn't configured: every hook does nothing. */
export const NO_ASSISTANT = {
  async alert() {},
  async eventChanged() {},
  async paymentDisputed() {},
  start() {},
  stop() {},
};

const pounds = (gbp) => money(Math.round(gbp * 100), { free: false });
/** Claude doesn't need contact details to suggest actions, so they stay out of the report request. */
const withoutEmails = (value) => JSON.parse(JSON.stringify(value, (key, v) => (key === 'email' || key === 'host_email' ? undefined : v)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The Monday report as plain text. */
export function formatReport(digest, suggestions) {
  const w = digest.last_week;
  const before = digest.week_before;
  const lines = [
    `📊 Weekly report: ${shortDate(digest.week.start_date)} to ${shortDate(digest.week.end_date)}`,
    '',
    `Income: ${pounds(w.income_gbp)} (week before: ${pounds(before.income_gbp)})`,
    `Profit after card fees (est.): ${pounds(w.estimated_profit_gbp)}`,
    `Ticket sales: ${pounds(w.ticket_sales_gbp)} from ${plural(w.tickets_sold, 'ticket')} (${plural(w.paid_orders, 'order')})`,
    `Featured listings: ${pounds(w.income_breakdown_gbp.featured_listings)}`,
  ];
  if (w.refunds.orders) lines.push(`Refunds: ${plural(w.refunds.orders, 'order')}, ${pounds(w.refunds.amount_gbp)}`);
  lines.push(
    `New: ${plural(w.new_hosts, 'host')}, ${plural(w.new_buyer_accounts, 'buyer account')}, ${plural(w.events_created, 'event')}`,
    `Live events: ${digest.live_events}`,
  );
  if (digest.payments.startsWith('demo')) lines.push('(Payments are in demo mode: these are test purchases.)');

  if (digest.top_events_last_week.length) {
    lines.push('', 'Top events');
    for (const e of digest.top_events_last_week) {
      lines.push(`• ${e.title} (${e.host}): ${pounds(e.ticket_sales_gbp)} sales, ${pounds(e.your_fees_gbp)} to you`);
    }
  }
  if (digest.coming_up_next_7_days.length) {
    lines.push('', 'Coming up this week');
    for (const e of digest.coming_up_next_7_days) {
      lines.push(`• ${e.starts}: ${e.title}, ${e.tickets_sold}/${e.capacity} sold${e.featured_until ? ' (featured)' : ''}`);
    }
  }

  const n = digest.needs_attention;
  const attention = [];
  if (n.hosts_who_have_not_finished_payout_setup.length) {
    attention.push(`• Hosts who haven't finished payout setup, so can't sell paid tickets: ${n.hosts_who_have_not_finished_payout_setup.map((h) => `${h.name} (${h.email})`).join(', ')}`);
  }
  for (const e of n.drafts_older_than_3_days) attention.push(`• Draft not published yet: "${e.title}" by ${e.host} (${e.host_email})`);
  for (const e of n.slow_selling_events_in_next_14_days) {
    attention.push(`• Selling slowly: "${e.title}", ${e.tickets_sold}/${e.capacity} sold, starts ${e.starts}${e.featured_until ? ' (featured)' : ''}`);
  }
  for (const e of n.cancelled_events_with_buyers_still_owed_refunds) {
    attention.push(`• "${e.title}" was cancelled but ${plural(e.orders, 'buyer')} (${pounds(e.amount_gbp)}) still need refunding. Refund them in Stripe.`);
  }
  if (n.checkouts_stuck_over_an_hour) {
    attention.push(`• ${plural(n.checkouts_stuck_over_an_hour, 'checkout')} stuck for over an hour. Check the Stripe webhook is set up.`);
  }
  lines.push('', 'Needs attention', ...(attention.length ? attention : ['Nothing urgent.']));
  if (suggestions) lines.push('', 'Suggestions', suggestions);
  return lines.join('\n');
}

export function createAssistant({
  db, fees, payments, telegram, client = null, ownerChatId = null, siteUrl = null,
  now = () => new Date(), log = console,
}) {
  const data = createBusinessData({ db, fees, payments });
  const brain = client ? createBrain({ client, fees, payments, data }) : null;
  const owner = ownerChatId ? String(ownerChatId) : null;
  const getState = db.prepare('SELECT value FROM assistant_state WHERE key = ?');
  const setState = db.prepare('INSERT INTO assistant_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  let conversation = null; // { messages, lastAt } - one owner, one conversation
  const seenStripeEvents = new Set(); // Stripe may deliver an event more than once
  let running = false;
  let reportTimer = null;
  let reporting = false;

  async function notify(text) {
    if (!owner) return;
    try {
      await telegram.send(owner, text);
    } catch (err) {
      log.error('Assistant: could not message the owner:', err.message);
    }
  }

  const alert = (text) => notify(`⚠️ ${text}`);

  function keepTyping() {
    telegram.typing(owner);
    const timer = setInterval(() => telegram.typing(owner), 4500);
    return () => clearInterval(timer);
  }

  async function answer(text) {
    if (!brain) {
      return notify("I can send alerts and the weekly report, but answering questions needs an Anthropic API key. Add ANTHROPIC_API_KEY in Render, under Environment, to switch it on.");
    }
    const t = now();
    if (!conversation || t - conversation.lastAt > CONVERSATION_IDLE_MS || conversation.messages.length > MAX_CONVERSATION_MESSAGES) {
      conversation = { messages: [], lastAt: t };
    }
    const convo = conversation;
    convo.lastAt = t;
    const stopTyping = keepTyping();
    try {
      const reply = await brain.ask(convo.messages, `[${dateTime(t)} UK time] ${text}`);
      if (!reply.keep && conversation === convo) conversation = null;
      await notify(reply.text);
    } catch (err) {
      // A half-finished exchange can't be continued, so the next message starts afresh.
      if (conversation === convo) conversation = null;
      if (err instanceof RefusalError) {
        await notify("Sorry, I can't help with that one.");
      } else {
        log.error('Assistant: answering failed:', err);
        await notify('Sorry, something went wrong while I was looking that up. Please try again in a minute.');
      }
    } finally {
      stopTyping();
    }
  }

  async function sendWeeklyReport() {
    const digest = data.weeklyDigest(now());
    let suggestions = null;
    if (brain) {
      try {
        suggestions = await brain.weeklySuggestions(withoutEmails(digest));
      } catch (err) {
        log.error('Assistant: weekly suggestions failed:', err.message);
      }
    }
    await telegram.send(owner, formatReport(digest, suggestions));
  }

  /** Send the weekly report once each week, from Monday 8am UK time (or later, if the server was down). */
  async function checkWeeklyReport() {
    if (!owner || reporting) return;
    const t = now();
    const last = getState.get(REPORT_STATE_KEY)?.value;
    if (!last) {
      // First run: start with next Monday's report rather than one for a week already half over.
      setState.run(REPORT_STATE_KEY, t.toISOString());
      return;
    }
    const due = parseInputDateTime(`${mondayOf(t)}T08:00`);
    if (t < due || new Date(last) >= due) return;
    reporting = true;
    try {
      await sendWeeklyReport();
      setState.run(REPORT_STATE_KEY, t.toISOString());
    } catch (err) {
      log.error('Assistant: weekly report failed:', err.message);
    } finally {
      reporting = false;
    }
  }

  async function handleUpdate(update) {
    const msg = update.message;
    if (!msg || typeof msg.text !== 'string') return;
    const chatId = String(msg.chat.id);
    if (!owner) {
      // Setup mode: tell whoever messages the bot their own chat ID, and nothing else.
      await telegram.send(chatId, `Hello! This chat's ID is ${chatId}. To finish setting me up, put it in TELEGRAM_ASSISTANT_CHAT_ID in Render, under Environment.`);
      return;
    }
    if (chatId !== owner) {
      log.warn(`Assistant: ignored a message from chat ${chatId}`);
      return;
    }
    const text = msg.text.trim();
    const command = /^\/(\w+)/.exec(text)?.[1].toLowerCase();
    if (command === 'start' || command === 'help') return notify(HELP);
    if (command === 'new') {
      conversation = null;
      return notify('OK, starting a fresh conversation.');
    }
    if (command === 'report') {
      const stopTyping = keepTyping();
      try {
        await sendWeeklyReport();
      } finally {
        stopTyping();
      }
      return;
    }
    return answer(text);
  }

  async function pollLoop() {
    let offset;
    let retryMs = 15_000;
    while (running) {
      try {
        const updates = await telegram.updates(offset);
        retryMs = 15_000;
        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await handleUpdate(update);
          } catch (err) {
            log.error('Assistant: handling a message failed:', err);
          }
        }
      } catch (err) {
        if (!running) break;
        // e.g. a wrong token or Telegram being down: retry less and less often, up to every 5 minutes.
        log.error(`Assistant: Telegram polling failed (retrying in ${retryMs / 1000}s):`, err.message);
        await sleep(retryMs);
        retryMs = Math.min(retryMs * 2, 5 * 60_000);
      }
    }
  }

  /** Check a newly published or edited event, and alert the owner if it looks risky. */
  async function eventChanged(eventId) {
    if (!brain || !owner) return;
    try {
      const listing = data.eventForScreening(eventId);
      if (!listing) return;
      const result = await brain.screenEvent(listing);
      if (result.verdict !== 'review') return;
      const e = data.eventContact(eventId);
      await alert([
        `This event may need a look: "${e.title}" by ${e.host} (${e.host_email})`,
        ...result.reasons.map((r) => `• ${r}`),
        siteUrl ? `${siteUrl}/events/${eventId}` : `Event #${eventId}`,
      ].join('\n'));
    } catch (err) {
      log.error(`Assistant: checking event ${eventId} failed:`, err.message);
    }
  }

  /** Stripe charge.dispute.created / charge.dispute.closed. */
  async function paymentDisputed(stripeEvent) {
    if (seenStripeEvents.has(stripeEvent.id)) return;
    seenStripeEvents.add(stripeEvent.id);
    if (seenStripeEvents.size > 500) seenStripeEvents.delete(seenStripeEvents.values().next().value);
    try {
      const d = stripeEvent.data?.object ?? {};
      const pi = typeof d.payment_intent === 'string' ? d.payment_intent : d.payment_intent?.id;
      const what = data.paymentContext(pi) ?? `Stripe payment ${pi ?? d.charge ?? '(unknown)'}`;
      const amount = !d.currency || d.currency === 'gbp' ? money(d.amount ?? 0, { free: false }) : `${((d.amount ?? 0) / 100).toFixed(2)} ${d.currency.toUpperCase()}`;
      if (stripeEvent.type === 'charge.dispute.created') {
        const due = d.evidence_details?.due_by ? ` by ${dateTime(new Date(d.evidence_details.due_by * 1000))}` : '';
        const reason = String(d.reason ?? 'not given').replace(/_/g, ' ');
        await alert(`A buyer has disputed a payment: ${amount} on ${what}. Reason: ${reason}. Respond in your Stripe dashboard (Payments, then Disputes)${due}, or you lose the money plus Stripe's dispute fee.`);
      } else if (stripeEvent.type === 'charge.dispute.closed') {
        const outcome = { won: 'you won it, so you keep the money', lost: 'you lost it, so the buyer keeps the money' }[d.status] ?? `status: ${d.status}`;
        await notify(`The dispute on ${what} (${amount}) is closed: ${outcome}.`);
      }
    } catch (err) {
      log.error('Assistant: dispute alert failed:', err.message);
    }
  }

  function start() {
    if (running) return;
    running = true;
    if (!owner) log.warn('Assistant: TELEGRAM_ASSISTANT_CHAT_ID is not set. Message the bot on Telegram to get your chat ID.');
    if (!brain) log.warn('Assistant: ANTHROPIC_API_KEY is not set, so only alerts and the weekly figures are on.');
    pollLoop();
    checkWeeklyReport();
    reportTimer = setInterval(() => checkWeeklyReport(), REPORT_CHECK_MS);
    reportTimer.unref();
  }

  function stop() {
    running = false;
    clearInterval(reportTimer);
  }

  return { start, stop, alert, notify, eventChanged, paymentDisputed, handleUpdate, checkWeeklyReport, sendWeeklyReport };
}

/** The assistant if TELEGRAM_ASSISTANT_TOKEN is set; otherwise hooks that do nothing. */
export function assistantFromEnv({ db, fees, payments, env = process.env }) {
  const token = env.TELEGRAM_ASSISTANT_TOKEN?.trim();
  if (!token) return NO_ASSISTANT;
  return createAssistant({
    db, fees, payments,
    telegram: createTelegram({ token }),
    client: env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null,
    ownerChatId: env.TELEGRAM_ASSISTANT_CHAT_ID?.trim() || null,
    siteUrl: (env.APP_URL ?? env.RENDER_EXTERNAL_URL ?? '').replace(/\/+$/, '') || null,
  });
}
