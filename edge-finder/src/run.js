// One scheduled run: read button taps and commands from Telegram, settle
// finished bets, check the stop-loss, then scan and send any new picks.
import { scan, currentFairProb } from './scanner.js';
import { loadEvents, settleFinished } from './events.js';
import { report } from './store.js';
import { manualResult } from './settle.js';
import { esc } from './telegram.js';
import { money, pct, when, selection, ukDate } from './format.js';

const ICON = {
  tennis: '🎾', mma: '🥊', soccer: '⚽', basketball: '🏀', americanfootball: '🏈', icehockey: '🏒',
  rugbyunion: '🏉', rugbyleague: '🏉', cricket: '🏏',
};
const icon = (sport) => ICON[sport.split('_')[0]] ?? '🎯';

export const HELP = `<b>Commands</b>
/placed &lt;pick&gt; [odds] [stake]: log a pick, e.g. <code>/placed 3a2fce56 1.16 2</code> if you got a different price
/result &lt;bet&gt; &lt;won|lost|void&gt;: settle a bet by hand (tennis retirements, MMA)
/bets: open bets
/report: bankroll, win rate, profit
/resume: restart after the stop-loss paused betting

Commands are read at the next scheduled run (around 9am and 5pm).`;

export function pickMessage(p) {
  return [
    `${icon(p.sport)} <b>${esc(selection(p))}</b> @ <b>${p.odds}</b> with ${esc(p.bookTitle)}`,
    `${esc(p.home)} v ${esc(p.away)} · ${esc(p.league)} · ${when(p.commenceTime)}`,
    `Wins ${pct(p.fairProb, 0)} of the time (fair odds ${p.fairOdds.toFixed(2)}) · break-even ${pct(1 / p.odds, 0)} · edge +${pct(p.ev)}`,
    `Stake <b>${money(p.stake)}</b> to win ${money(p.stake * (p.odds - 1))}`,
    `Still worth it at <b>${p.minPrice}</b> or better; skip if the price has dropped below that.`,
    `Pick <code>${p.id}</code>`,
  ].join('\n');
}

function reportText(store, cfg) {
  const r = report(store.all());
  const bank = store.bankroll(cfg.bankroll);
  const lines = [`Bankroll <b>${money(bank)}</b> (started ${money(cfg.bankroll)}) · ${r.open} open bet${r.open === 1 ? '' : 's'}`];
  if (r.decided) {
    lines.push(`Won ${r.wins} of ${r.decided}: <b>${pct(r.winRate, 0)}</b> (expected ${pct(r.expectedWinRate, 0)}, break-even ${pct(r.breakEvenWinRate, 0)})`);
    lines.push(`Profit ${money(r.pnl)} on ${money(r.staked)} staked (ROI ${pct(r.roi)})`);
    if (r.decided < 300) lines.push(`<i>True win rate likely ${pct(r.winRateLow, 0)}–${pct(r.winRateHigh, 0)}; it narrows as bets add up.</i>`);
  }
  return lines.join('\n');
}

function placeBet(store, pick, { odds = pick.odds, stake = pick.stake, now }) {
  const id = store.addBet(pick, { odds, stake, now });
  store.setPickStatus(pick.id, 'placed');
  return `✅ Logged bet ${id}: ${esc(selection(pick))} @ ${odds}, ${money(stake)}`;
}

/** Handles everything you sent since the last run. */
async function handleUpdates({ store, bot, cfg, now }) {
  const offset = Number(store.getMeta('telegram_offset') ?? 0);
  const updates = await bot.updates(offset || undefined);
  for (const u of updates) {
    store.setMeta('telegram_offset', u.update_id + 1);
    try {
      if (u.callback_query) await onButton(u.callback_query, { store, bot, now });
      else if (u.message?.text && String(u.message.chat.id) === bot.chatId) await onCommand(u.message, { store, bot, cfg, now });
    } catch (err) {
      await bot.send(`⚠️ ${esc(err.message)}`);
    }
  }
}

async function onButton(cq, { store, bot, now }) {
  if (String(cq.message?.chat.id) !== bot.chatId) return; // someone else found the bot
  const [action, id] = cq.data.split(':');
  const pick = store.pick(id);
  await bot.removeButtons(cq.message.message_id);
  if (!pick) return;
  if (pick.status !== 'sent') {
    await bot.answer(cq.id, `Already ${pick.status}`);
    return;
  }
  if (action === 'place') {
    await bot.send(placeBet(store, pick, { now }), { replyTo: cq.message.message_id });
  } else if (action === 'skip') {
    store.setPickStatus(id, 'skipped');
  }
  await bot.answer(cq.id, 'Done');
}

async function onCommand(msg, { store, bot, cfg, now }) {
  const [cmd, ...args] = msg.text.trim().split(/\s+/);
  const reply = (text) => bot.send(text, { replyTo: msg.message_id });
  switch (cmd.replace(/@.*/, '').toLowerCase()) {
    case '/placed': {
      const pick = store.pick(args[0]);
      if (!pick) return reply(`No pick <code>${esc(args[0] ?? '')}</code>. Use the 8-character code at the bottom of a pick.`);
      if (pick.status === 'placed') return reply('That pick is already logged.');
      const odds = args[1] ? Number(args[1]) : pick.odds;
      const stake = args[2] ? Number(args[2]) : pick.stake;
      if (!(odds > 1) || !(stake > 0)) return reply('Odds must be above 1 and stake above 0, e.g. <code>/placed 3a2fce56 1.16 2</code>');
      const warning = odds < (pick.minPrice ?? 0) ? `\n⚠️ ${odds} is below the ${pick.minPrice} worth taking, so this bet has little or no edge.` : '';
      return reply(placeBet(store, pick, { odds, stake, now }) + warning);
    }
    case '/result': {
      const bet = store.get(Number(args[0]));
      if (!bet) return reply(`No bet ${esc(args[0] ?? '')}. Send /bets to see their numbers.`);
      if (bet.status !== 'open') return reply(`Bet ${bet.id} is already settled (${bet.status}).`);
      const result = manualResult(bet, (args[1] ?? '').toLowerCase());
      store.settle(bet.id, result, now);
      return reply(`Bet ${bet.id}: ${result.status} ${money(result.pnl)}`);
    }
    case '/bets': {
      const open = store.open();
      if (!open.length) return reply('No open bets.');
      return reply(open.map((b) => `<b>${b.id}</b> ${esc(selection(b))} @ ${b.odds}, ${money(b.stake)} · ${when(b.commence_time)}`).join('\n'));
    }
    case '/report':
      return reply(reportText(store, cfg));
    case '/resume': {
      const bank = store.bankroll(cfg.bankroll);
      store.setMeta('stop_base', bank);
      return reply(`Resumed. New stop-loss: ${money(store.stopLevel(cfg.bankroll, cfg.stopLossPct))}.`);
    }
    default:
      return reply(HELP);
  }
}

/** Warns once about any of your bookmakers that never appears in the odds data (wrong code, or not covered). */
function missingBooks(store, cfg, events) {
  if (!events.length || !cfg.books.length) return [];
  const seen = new Set(events.flatMap((e) => (e.bookmakers ?? []).map((b) => b.key)));
  const warned = new Set((store.getMeta('warned_books') ?? '').split(',').filter(Boolean));
  const missing = cfg.books.filter((b) => !seen.has(b) && !warned.has(b));
  if (!missing.length) return [];
  store.setMeta('warned_books', [...warned, ...missing].join(','));
  return [`⚠️ No prices found from: ${missing.join(', ')}. Check the bookmaker code in EDGE_BOOKS, or it may just have no odds on these matches yet.`];
}

/**
 * Finds the chat to send to when TELEGRAM_CHAT_ID isn't set: the first person
 * to message the bot privately. Saved, so it only happens once.
 */
export async function linkChat(store, api) {
  const saved = store.getMeta('chat_id');
  if (saved) return { chatId: saved, isNew: false };
  const first = (await api.updates()).find((u) => u.message?.chat.type === 'private');
  if (!first) throw new Error('Open your bot in Telegram, send it any message (e.g. "hi"), then run the workflow again.');
  store.setMeta('chat_id', first.message.chat.id);
  return { chatId: String(first.message.chat.id), isNew: true };
}

export async function runOnce({ cfg, store, bot, now = new Date(), fixture, scoresFile, fetchImpl = fetch }) {
  await handleUpdates({ store, bot, cfg, now });

  // Settle before scanning so the bankroll (and the stakes) are up to date.
  const { settled } = await settleFinished(store, cfg, { now, scoresFile, fetchImpl });
  for (const s of settled) {
    const mark = { won: '✅', lost: '❌' }[s.status] ?? '➖';
    await bot.send(`${mark} Bet ${s.bet.id} ${s.status}: ${esc(s.bet.home)} ${s.home}–${s.away} ${esc(s.bet.away)} · ${esc(selection(s.bet))} · ${money(s.pnl)}`);
  }
  // MMA and some tennis have no scores in the API; ask once the result should be known.
  const unsettled = store.open().filter((b) => Date.parse(b.commence_time) < now.getTime() - 24 * 3600e3);
  if (unsettled.length) {
    await bot.send(`Please settle by hand (no score found):\n${unsettled.map((b) => `<b>${b.id}</b> ${esc(selection(b))}: <code>/result ${b.id} won</code> or <code>lost</code>`).join('\n')}`);
  }

  const bankroll = store.bankroll(cfg.bankroll);
  const stop = store.stopLevel(cfg.bankroll, cfg.stopLossPct);
  const footer = [];
  let sent = 0;
  const diag = { events: 0, skipped: [], overBudget: [], budget: Infinity, errors: [], remaining: null, found: 0 };

  if (bankroll <= stop) {
    footer.push(`⏸ <b>Paused.</b> Bankroll ${money(bankroll)} has hit your ${money(stop)} stop-loss, so no new picks. Look back over your bets, then send /resume if you want to carry on.`);
  } else {
    const { events, remaining, errors, skipped, overBudget, budget } = await loadEvents(cfg, { fixture, now: now.getTime(), fetchImpl });
    Object.assign(diag, { events: events.length, skipped, overBudget, budget, errors, remaining });
    // Keep each open bet's latest sharp price, for closing line value.
    for (const b of store.open().filter((x) => Date.parse(x.commence_time) > now.getTime())) {
      const p = currentFairProb(events, b, cfg, now.getTime());
      if (p != null) store.setClose(b.id, p, now);
    }
    const found = scan(events, { ...cfg, bankroll }, now.getTime())
      .filter((p) => !p.suspicious && p.stake > 0 && !store.pick(p.id));
    // Best picks first; anything over the daily limit can still go out on a later day if it's still value.
    const room = cfg.maxPicksPerDay > 0 ? Math.max(0, cfg.maxPicksPerDay - store.picksSentOn(now, ukDate)) : Infinity;
    const picks = found.slice(0, room);
    diag.found = found.length;
    for (const p of picks) {
      await bot.send(pickMessage(p), { buttons: [[{ text: '✅ Placed', callback_data: `place:${p.id}` }, { text: 'Skip', callback_data: `skip:${p.id}` }]] });
      store.recordPick(p, now);
      sent++;
    }
    if (found.length > picks.length) footer.push(`${found.length - picks.length} more pick${found.length - picks.length === 1 ? '' : 's'} held back by your ${cfg.maxPicksPerDay}-a-day limit.`);
    else if (!sent) footer.push('No new picks this time. Most scans find none; that is normal.');
    footer.push(...missingBooks(store, cfg, events));
    if (errors.length) footer.push(`⚠️ Couldn't load: ${esc(errors.join('; '))}`);
    if (remaining != null && remaining < 60) footer.push(`⚠️ Only ${remaining} Odds API credits left this month.`);
  }

  await bot.send([reportText(store, cfg), ...footer].join('\n\n'));
  return { sent, settled: settled.length, bankroll, paused: bankroll <= stop, ...diag };
}
