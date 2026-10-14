// One scheduled run: read button taps and commands from Telegram, settle
// finished bets, check the stop-loss, then scan and send any new picks.
import { scan, currentFairProb } from './scanner.js';
import { loadEvents, settleFinished } from './events.js';
import { report, doublesReport } from './store.js';
import { findDoubles, fractional } from './doubles.js';
import { findScorelineDoubles } from './scorelines.js';
import { manualResult } from './settle.js';
import { esc } from './telegram.js';
import { money, pct, when, selection, ukDate, icon } from './format.js';


export const HELP = `<b>Commands</b>
/placed &lt;pick&gt; [odds] [stake]: log a pick, e.g. <code>/placed 3a2fce56 1.16 2</code> if you got a different price
/result &lt;bet&gt; &lt;won|lost|void&gt;: settle a bet by hand (tennis retirements, MMA, cricket); doubles are D1, D2…
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

export function doubleMessage(d) {
  return [
    `🎲 <b>Fun double</b> @ <b>${d.odds}</b> (${fractional(d.odds)}) with ${esc(d.bookTitle)}`,
    ...d.legs.map((l, i) => `${i + 1}. ${icon(l.sport)} ${esc(selection(l))} @ ${l.odds} · ${esc(l.home)} v ${esc(l.away)} · ${when(l.commenceTime)}`),
    `Wins about 1 in ${Math.round(1 / d.fairProb)} (fair odds ${d.fairOdds.toFixed(1)}) · edge +${pct(d.ev, 0)}`,
    `Stake <b>${money(d.stake)}</b> to win ${money(d.stake * (d.odds - 1))}. Still worth it at ${d.minPrice} or better combined.`,
    `<i>A long shot: expect to lose most of these. Not counted in your win rate.</i>`,
    `Pick <code>${d.id}</code>`,
  ].join('\n');
}

export function scorelineMessage(d) {
  return [
    `🎲⚽ <b>Scoreline double</b>, about ${fractional(d.odds)} or better`,
    ...d.legs.map((l, i) => `${i + 1}. <b>${esc(selection(l))}</b> · ${esc(l.league)} · ${when(l.commenceTime)}\n    chance ${pct(l.fairProb)} (fair odds ${(1 / l.fairProb).toFixed(2)}) · <b>only at ${l.odds} or better</b>`),
    `Wins about 1 in ${Math.round(1 / d.fairProb)}. Correct-score prices aren't in the odds data, so check both at any of your bookmakers: <b>bet only if both prices are at least these</b>. Most of the time they won't be.`,
    `Stake <b>${money(d.stake)}</b>. Placed logs it at ${d.odds}; send <code>/placed ${d.id} &lt;combined odds&gt;</code> if you got more.`,
    `<i>Not counted in your win rate.</i> Pick <code>${d.id}</code>`,
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
  const d = doublesReport(store.allDoubles());
  if (d.placed) lines.push(`🎲 Fun doubles: ${d.placed} placed, ${d.won} won, ${d.lost} lost · ${money(d.pnl)}`);
  return lines.join('\n');
}

function placeBet(store, pick, { odds = pick.odds, stake = pick.stake, now }) {
  store.setPickStatus(pick.id, 'placed');
  if (pick.kind === 'double') {
    const id = store.addDouble(pick, { odds, stake, now });
    return `✅ Logged double D${id} @ ${odds}, ${money(stake)}`;
  }
  const id = store.addBet(pick, { odds, stake, now });
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
      if (/^d\d+$/i.test(args[0] ?? '')) {
        const dbl = store.getDouble(Number(args[0].slice(1)));
        if (!dbl) return reply(`No double ${esc(args[0])}. Send /bets to see them.`);
        if (dbl.status !== 'open') return reply(`Double D${dbl.id} is already settled (${dbl.status}).`);
        const result = manualResult(dbl, (args[1] ?? '').toLowerCase());
        store.settleDouble(dbl.id, result, now);
        return reply(`Double D${dbl.id}: ${result.status} ${money(result.pnl)}`);
      }
      const bet = store.get(Number(args[0]));
      if (!bet) return reply(`No bet ${esc(args[0] ?? '')}. Send /bets to see their numbers.`);
      if (bet.status !== 'open') return reply(`Bet ${bet.id} is already settled (${bet.status}).`);
      const result = manualResult(bet, (args[1] ?? '').toLowerCase());
      store.settle(bet.id, result, now);
      return reply(`Bet ${bet.id}: ${result.status} ${money(result.pnl)}`);
    }
    case '/bets': {
      const lines = [
        ...store.open().map((b) => `<b>${b.id}</b> ${esc(selection(b))} @ ${b.odds}, ${money(b.stake)} · ${when(b.commence_time)}`),
        ...store.openDoubles().map((d) => `<b>D${d.id}</b> 🎲 ${d.legs.map((l) => `${esc(selection(l))}${l.result ? ` (${l.result})` : ''}`).join(' + ')} @ ${d.odds}, ${money(d.stake)}`),
      ];
      return reply(lines.length ? lines.join('\n') : 'No open bets.');
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
  const { settled, settledDoubles } = await settleFinished(store, cfg, { now, scoresFile, fetchImpl });
  for (const s of settled) {
    const mark = { won: '✅', lost: '❌' }[s.status] ?? '➖';
    await bot.send(`${mark} Bet ${s.bet.id} ${s.status}: ${esc(s.bet.home)} ${s.home}–${s.away} ${esc(s.bet.away)} · ${esc(selection(s.bet))} · ${money(s.pnl)}`);
  }
  for (const s of settledDoubles) {
    const mark = { won: '🎉', lost: '❌' }[s.status] ?? '➖';
    const legs = s.double.legs.map((l) => `${esc(selection(l))} ${l.result ? `(${l.result}${l.score ? ` ${l.score}` : ''})` : ''}`).join(' + ');
    await bot.send(`${mark} Double D${s.double.id} ${s.status}: ${legs} · ${money(s.pnl)}`);
  }
  // MMA, cricket and some tennis have no scores in the API; ask once the result should be known.
  const dayAgo = now.getTime() - 24 * 3600e3;
  const unsettled = [
    ...store.open().filter((b) => Date.parse(b.commence_time) < dayAgo)
      .map((b) => `<b>${b.id}</b> ${esc(selection(b))}: <code>/result ${b.id} won</code> or <code>lost</code>`),
    ...store.openDoubles().filter((d) => d.legs.every((l) => l.result || Date.parse(l.commenceTime) < dayAgo))
      .map((d) => `<b>D${d.id}</b> 🎲 double: <code>/result D${d.id} won</code> or <code>lost</code>`),
  ];
  if (unsettled.length) await bot.send(`Please settle by hand (no score found):\n${unsettled.join('\n')}`);

  const bankroll = store.bankroll(cfg.bankroll);
  const stop = store.stopLevel(cfg.bankroll, cfg.stopLossPct);
  const footer = [];
  let sent = 0;
  let doublesSent = 0;
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

    if (cfg.doubles && cfg.books.length) {
      const weekAgo = new Date(now.getTime() - 7 * 864e5);
      const room = Math.max(0, cfg.doublesPerWeek - store.doublesSentSince(weekAgo));
      // Value doubles first (their prices are checked); scoreline doubles fill any room left.
      const doubles = [
        ...findDoubles(events, cfg, now.getTime()),
        ...(cfg.scorelines ? findScorelineDoubles(events, cfg, now.getTime()) : []),
      ].filter((d) => !store.pick(d.id)).slice(0, room);
      for (const d of doubles) {
        await bot.send(d.type === 'scoreline' ? scorelineMessage(d) : doubleMessage(d), { buttons: [[{ text: '✅ Placed', callback_data: `place:${d.id}` }, { text: 'Skip', callback_data: `skip:${d.id}` }]] });
        store.recordPick(d, now);
        doublesSent++;
      }
    }

    if (found.length > picks.length) footer.push(`${found.length - picks.length} more pick${found.length - picks.length === 1 ? '' : 's'} held back by your ${cfg.maxPicksPerDay}-a-day limit.`);
    else if (!sent && !doublesSent) footer.push('No new picks this time. Most scans find none; that is normal.');
    footer.push(...missingBooks(store, cfg, events));
    if (errors.length) footer.push(`⚠️ Couldn't load: ${esc(errors.join('; '))}`);
    if (remaining != null && remaining < 60) footer.push(`⚠️ Only ${remaining} Odds API credits left this month.`);
  }

  await bot.send([reportText(store, cfg), ...footer].join('\n\n'));
  return { sent, doublesSent, settled: settled.length + settledDoubles.length, bankroll, paused: bankroll <= stop, ...diag };
}
