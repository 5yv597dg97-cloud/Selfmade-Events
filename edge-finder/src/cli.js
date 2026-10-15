#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { fetchSports } from './odds-api.js';
import { scan, currentFairProb } from './scanner.js';
import { openStore, report } from './store.js';
import { manualResult } from './settle.js';
import { loadEvents as fetchEvents, settleFinished } from './events.js';
import { telegram } from './telegram.js';
import { runOnce, linkChat, HELP as BOT_HELP } from './run.js';
import { findDoubles, fractional } from './doubles.js';
import { findScorelineDoubles } from './scorelines.js';
import { previewMatches, previewText } from './preview.js';
import { loadHistory, seasonCode, LEAGUES } from './history.js';
import { backtest, trixieBacktest } from './backtest.js';
import { ratingsFor } from './statsview.js';
import { gbp, pct, when, selection } from './format.js';

const LAST_SCAN = '.last-scan.json';

const HELP = `edge-finder: finds bets priced better than the sharp market says they should be

Usage: npm run edge -- <command> [options]

  scan                 Find value bets now (saves them for "place")
  place <n|id>         Log pick #n from the last scan as placed
                         --odds <x>   price you actually got   --stake <£>  amount you actually staked
  bets                 List open bets
  close                Record the current sharp price on open bets (run near kick-off for CLV)
  settle               Grade finished open bets from final scores
  settle <bet> <result>  Set a result by hand: won, lost, push, void, half-won, half-lost
  report               Profit, ROI, and closing line value
  sports               List sport keys your API key can query
  preview              Every match today with chances, best prices and likeliest scores (--sports, --telegram)
  trixie-test          Replay a trixie a week over past seasons (--telegram to send the summary)
  backtest             Test the results-based model on past seasons (--telegram to send the summary)
  run                  The scheduled job: Telegram taps/commands, settle, scan, send picks
  telegram-setup       Show your Telegram chat ID (message your bot first)

Scan options (or the env vars in README.md):
  --profile safe|value   safe (default): 75%+ win chance, tennis, MMA & EPL, Paddy Power/Betfair Sportsbook
                         value: any odds from 1.30 to 4.00 with an edge
  --sports a,b (tennis_* = all tennis)  --books a,b  --bankroll 1000  --min-edge 0.02  --min-prob 0.4
  --min-odds 1.3  --max-odds 4  --kelly-fraction 0.25  --max-stake-pct 0.02
  --devig-method power|shin|multiplicative  --consensus  --all-per-event
  --fixture <file.json>  read odds from a file instead of the API (no key needed)
  --now <iso>            pretend the time is this (for fixtures)
  --json                 print machine-readable output`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    if (key === 'all-per-event') { flags['one-per-event'] = false; continue; }
    if (['consensus', 'json', 'telegram'].includes(key)) { flags[key] = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    flags[key] = value;
  }
  return { positional, flags };
}

async function loadEvents(cfg, flags, sports = cfg.sports, now = Date.now()) {
  const { events, remaining, errors, skipped, overBudget } = await fetchEvents(cfg, { sports, fixture: flags.fixture, now });
  if (skipped.length) console.error(`  (Nothing starting soon, skipped for free: ${skipped.join(', ')})`);
  if (overBudget.length) console.error(`  (Over this run's credit budget, not scanned: ${overBudget.join(', ')})`);
  for (const e of errors) console.error(`  ! ${e}`);
  if (remaining != null) console.error(`  (Odds API credits left: ${remaining})`);
  return events;
}

function printPicks(picks, cfg) {
  if (!picks.length) {
    console.log('No value bets right now. That is the normal state of an efficient market; check again later.');
    return;
  }
  if (cfg.paused) {
    console.log(`Paused: bankroll ${gbp.format(cfg.bankroll)} is at or below the ${gbp.format(cfg.stopLevel)} stop-loss.`);
    return;
  }
  console.log(`Value bets, "${cfg.profile}" profile  (win chance ≥ ${pct(cfg.minProb, 0)}, bankroll ${gbp.format(cfg.bankroll)}, ${cfg.kellyFraction}x Kelly, cap ${pct(cfg.maxStakePct)} per bet)\n`);
  picks.forEach((p, i) => {
    const flag = p.suspicious ? '  ⚠ edge too large: likely a stale or mismatched line, check before betting' : '';
    console.log(`#${i + 1} [${p.id}] ${p.home} v ${p.away}  · ${p.league} · ${when(p.commenceTime)}${flag}`);
    console.log(`    ${selection(p)} @ ${p.odds} with ${p.bookTitle}`);
    console.log(`    wins ${pct(p.fairProb)} of the time (fair odds ${p.fairOdds.toFixed(2)}, from ${p.fairSource}); needs ${pct(1 / p.odds)} to break even`);
    console.log(`    edge +${pct(p.ev)}  ·  stake ${gbp.format(p.stake)} to win ${gbp.format(p.stake * (p.odds - 1))}  ·  still worth it at ${p.minPrice} or better`);
    if (p.alsoAt.length) console.log(`    also value at: ${p.alsoAt.join(', ')}`);
    console.log('');
  });
  const total = picks.reduce((a, p) => a + p.stake, 0);
  const expected = picks.reduce((a, p) => a + p.stake * p.ev, 0);
  console.log(`Total stake ${gbp.format(total)} · expected profit ${gbp.format(expected)} (an average over many bets, not a forecast for these)`);
}

async function main() {
  const { positional: [command, ...args], flags } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || flags.help) return console.log(HELP);
  const cfg = loadConfig(process.env, flags);
  const now = flags.now ? new Date(flags.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('--now must be an ISO date');

  if (command === 'preview') {
    // Look at the whole card, so don't skip anything for the credit budget.
    const pcfg = { ...cfg, creditBudget: false };
    const events = await loadEvents(pcfg, flags, cfg.sports, now.getTime());
    let ratings = {};
    try {
      ratings = flags.fixture ? {} : await ratingsFor(events, now.getTime());
    } catch (err) {
      console.error(`  (Stats model unavailable: ${err.message})`);
    }
    const messages = previewText(previewMatches(events, pcfg, now.getTime(), { today: !flags.hours, hours: Number(flags.hours) || 24, ratings }), cfg);
    if (flags.telegram) {
      const store = openStore(cfg.db);
      const chatId = cfg.telegramChatId || store.getMeta('chat_id');
      store.close();
      if (!cfg.telegramToken || !chatId) throw new Error('Telegram isn\'t linked yet: run the normal workflow first');
      const bot = telegram({ token: cfg.telegramToken, chatId });
      for (const m of messages) await bot.send(m);
    }
    for (const m of messages) console.log(m.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), '\n');
    return;
  }

  if (command === 'trixie-test') {
    const seasons = [3, 2, 1].map((b) => seasonCode(now.getTime(), b));
    const matches = await loadHistory({ seasons, now: now.getTime(), log: console.log });
    if (!matches.length) throw new Error('No historical data could be downloaded from football-data.co.uk');
    const r = trixieBacktest(matches, { seasons });
    const units = (x) => `${x >= 0 ? '+' : '−'}£${Math.abs(x * 0.5).toFixed(2)}`; // £0.50 a line
    const block = (title, s) => (!s.trixies ? `<b>${title}</b>\nNo week qualified.` : [
      `<b>${title}</b>`,
      `${s.trixies} trixies (£${(s.trixies * 2).toFixed(0)} staked)`,
      `All 3 won: ${s.allThree} (${pct(s.allThree / s.trixies, 0)}) · paid something: ${s.returned} (${pct(s.returned / s.trixies, 0)})`,
      `Profit ${units(s.profit)} · ROI ${s.roi >= 0 ? '+' : ''}${pct(s.roi)} · longest run with nothing back: ${s.worstRun} weeks · worst drop ${units(s.low)}`,
    ].join('\n'));
    const lines = [
      `<b>Trixie test</b>: ${r.weeks} weeks, ${matches.length} real matches, 10 European leagues, seasons ${seasons.join(', ')}. £0.50 a line (£2 a trixie). Each leg is a match favourite by Pinnacle's price.`,
      '',
      `The week's single biggest favourite failed to win in ${r.favouriteFailed} of ${r.weeks} weeks (${pct(r.favouriteFailed / r.weeks, 0)}).`,
      '',
      block('1. The 3 biggest favourites every week, Bet365 prices', r.strongest),
      '',
      block('2. The same, at the best price any bookmaker offered', r.strongestBest),
      '',
      block('3. System rules: 75%+ legs priced at least fair, trixie 2%+ value', r.value[0.75]),
      '',
      block('4. Same rules with 65%+ legs', r.value[0.65]),
      '',
      block('5. Same rules with 50%+ legs', r.value[0.5]),
      '',
      'Weeks that went wrong (strategy 1):',
      ...r.strongest.examples,
    ];
    const text = lines.join('\n');
    console.log(text.replace(/<[^>]+>/g, ''));
    if (flags.telegram) {
      const store = openStore(cfg.db);
      const chatId = cfg.telegramChatId || store.getMeta('chat_id');
      store.close();
      if (cfg.telegramToken && chatId) await telegram({ token: cfg.telegramToken, chatId }).send(text);
    }
    return;
  }

  if (command === 'backtest') {
    const seasons = [3, 2, 1, 0].map((b) => seasonCode(now.getTime(), b));
    const testSeasons = seasons.slice(1, 3); // the last two complete seasons
    console.log(`Loading ${Object.keys(LEAGUES).length} leagues, seasons ${seasons.join(', ')}…`);
    const matches = (await loadHistory({ seasons, now: now.getTime(), log: console.log }))
      .filter((m) => m.season !== seasons[3]);
    if (!matches.length) throw new Error('No historical data could be downloaded from football-data.co.uk');
    console.log(`${matches.length} matches loaded. Testing on ${testSeasons.join(' and ')}.\n`);
    const lines = [];
    const f = (x) => x.toFixed(4);
    const money = (b) => `${b.bets} bets, won ${pct(b.winRate, 0)}, ROI ${b.roi >= 0 ? '+' : ''}${pct(b.roi)}`;
    let best = null;
    for (const halfLifeDays of [90, 180, 365]) {
      for (const blend of [0.1, 0.25]) {
        const r = backtest(matches, { testSeasons, halfLifeDays, blend });
        const gain = r.accuracy.market - r.accuracy.blend;
        if (!best || gain > best.gain) best = { gain, halfLifeDays, blend, r };
        console.log(`half-life ${halfLifeDays}d, blend ${blend}: log loss model ${f(r.accuracy.model)} · market ${f(r.accuracy.market)} · blend ${f(r.accuracy.blend)} (${r.accuracy.matches} matches)`);
      }
    }
    const { r, halfLifeDays, blend, gain } = best;
    lines.push(`<b>Stats model backtest</b> (${r.accuracy.matches} matches, ${testSeasons.join(' & ')} seasons, top European leagues)`);
    lines.push('');
    lines.push(`<b>Accuracy</b> (log loss, lower is better)`);
    lines.push(`Market (Pinnacle): ${f(r.accuracy.market)}`);
    lines.push(`Stats model alone: ${f(r.accuracy.model)}`);
    lines.push(`Market + ${blend * 100}% model: ${f(r.accuracy.blend)} ${gain > 0.0005 ? '✅ model adds information' : gain > 0 ? '➖ tiny improvement' : '❌ no improvement'}`);
    lines.push('');
    lines.push(`<b>Value bets</b> (1 unit each at Bet365/William Hill, half-life ${halfLifeDays} days)`);
    lines.push(`All value bets: ${money(r.bets.all)}`);
    lines.push(`… model agrees: ${money(r.bets.allAgree)}`);
    lines.push(`… model disagrees: ${money(r.bets.allDisagree)}`);
    lines.push(`75%+ value bets: ${money(r.bets.safe)}`);
    lines.push(`… model agrees: ${money(r.bets.safeAgree)}`);
    lines.push(`… model disagrees: ${money(r.bets.safeDisagree)}`);
    lines.push(`Model alone (5%+ edge by its own numbers): ${money(r.bets.modelOnly)}`);
    lines.push('');
    lines.push('By league (log loss, market → blend):');
    for (const [k, x] of Object.entries(r.byLeague)) lines.push(`${LEAGUES[k] ?? k}: ${f(x.market)} → ${f(x.blend)} (${x.matches})`);
    const text = lines.join('\n');
    console.log(`\n${text.replace(/<[^>]+>/g, '')}`);
    if (flags.telegram) {
      const store = openStore(cfg.db);
      const chatId = cfg.telegramChatId || store.getMeta('chat_id');
      store.close();
      if (cfg.telegramToken && chatId) await telegram({ token: cfg.telegramToken, chatId }).send(text);
    }
    return;
  }

  if (command === 'sports') {
    const { data } = await fetchSports({ apiKey: cfg.apiKey });
    for (const s of data.filter((s) => s.active)) console.log(`${s.key.padEnd(40)} ${s.title}`);
    return;
  }

  if (command === 'telegram-setup') {
    if (!cfg.telegramToken) throw new Error('Set TELEGRAM_BOT_TOKEN first (from @BotFather)');
    const chats = new Map();
    for (const u of await telegram({ token: cfg.telegramToken }).updates()) {
      const chat = (u.message ?? u.callback_query?.message)?.chat;
      if (chat) chats.set(chat.id, chat.first_name ?? chat.title ?? '');
    }
    if (!chats.size) return console.log('No messages yet. Send your bot any message in Telegram, then run this again.');
    for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID=${id}   (${name})`);
    return;
  }

  if (command === 'scan') {
    const events = await loadEvents(cfg, flags, cfg.sports, now.getTime());
    // Size stakes from the current bankroll, and respect the stop-loss.
    const store = openStore(cfg.db);
    const bankroll = store.bankroll(cfg.bankroll);
    const stopLevel = store.stopLevel(cfg.bankroll, cfg.stopLossPct);
    store.close();
    const live = { ...cfg, bankroll, stopLevel, paused: bankroll <= stopLevel };
    const picks = live.paused ? [] : scan(events, live, now.getTime());
    writeFileSync(LAST_SCAN, JSON.stringify(picks, null, 2));
    const doubles = live.paused || !cfg.doubles || !cfg.books.length ? [] : findDoubles(events, live, now.getTime());
    const scorelines = live.paused || !cfg.scorelines ? [] : findScorelineDoubles(events, live, now.getTime());
    if (flags.json) return console.log(JSON.stringify({ picks, doubles, scorelines }, null, 2));
    printPicks(picks, live);
    if (doubles.length) {
      console.log(`\nFun doubles (${gbp.format(cfg.doubleStake)} each, not part of the win rate)\n`);
      for (const d of doubles) {
        console.log(`[${d.id}] ${d.odds} (${fractional(d.odds)}) with ${d.bookTitle}: wins about 1 in ${Math.round(1 / d.fairProb)}, edge +${pct(d.ev, 0)}`);
        for (const l of d.legs) console.log(`    ${selection(l)} @ ${l.odds}  ·  ${l.home} v ${l.away}  ·  ${when(l.commenceTime)}`);
      }
    }
    if (scorelines.length) {
      console.log(`\nScoreline doubles (bet only if your bookmaker offers at least these prices)\n`);
      for (const d of scorelines.slice(0, 5)) {
        console.log(`[${d.id}] about ${fractional(d.odds)} or better: wins about 1 in ${Math.round(1 / d.fairProb)}`);
        for (const l of d.legs) console.log(`    ${selection(l)}: chance ${pct(l.fairProb)}, only at ${l.odds} or better  ·  ${when(l.commenceTime)}`);
      }
    }
    return;
  }

  const store = openStore(cfg.db);
  try {
    if (command === 'run') {
      if (!cfg.telegramToken) throw new Error('Set TELEGRAM_BOT_TOKEN (see README)');
      let chatId = cfg.telegramChatId;
      let isNew = false;
      if (!chatId) ({ chatId, isNew } = await linkChat(store, telegram({ token: cfg.telegramToken })));
      const bot = telegram({ token: cfg.telegramToken, chatId });
      if (isNew) await bot.send(`👋 Linked to this chat. Picks will arrive here around 9am and 5pm.\n\n${BOT_HELP}`);
      const r = await runOnce({ cfg, store, bot, now, fixture: flags.fixture, scoresFile: flags.scores });
      console.log(`Sent ${r.sent} picks, ${r.doublesSent} doubles and ${r.trixiesSent} trixies, settled ${r.settled} bets, bankroll ${gbp.format(r.bankroll)}${r.paused ? ' (paused)' : ''}`);
      console.log(`Matches with odds: ${r.events} · value picks found: ${r.found} · API credits left: ${r.remaining ?? 'unknown'}`);
      if (r.budget !== Infinity) console.log(`Credit budget this run: ${r.budget}`);
      if (r.skipped.length) console.log(`Skipped (nothing in the next ${cfg.lookaheadHours}h): ${r.skipped.join(', ')}`);
      if (r.overBudget.length) console.log(`Left for a later run (budget used up): ${r.overBudget.join(', ')}`);
      for (const e of r.errors) console.log(`Error: ${e}`);
      return;
    }

    if (command === 'place') {
      if (!existsSync(LAST_SCAN)) throw new Error('Run "scan" first');
      const picks = JSON.parse(readFileSync(LAST_SCAN, 'utf8'));
      const ref = args[0];
      const pick = /^\d+$/.test(ref ?? '') ? picks[Number(ref) - 1] : picks.find((p) => p.id === ref);
      if (!pick) throw new Error(`No pick "${ref}" in the last scan`);
      const odds = flags.odds ? Number(flags.odds) : pick.odds;
      if (pick.suspicious && !flags.stake) throw new Error('That pick was flagged as a likely stale line. Check the price, then pass --stake to log it anyway');
      const stake = flags.stake ? Number(flags.stake) : pick.stake;
      if (!(odds > 1) || !(stake > 0)) throw new Error('Odds must be above 1 and stake above 0');
      if (odds < pick.minPrice) console.warn(`Warning: ${odds} is below the ${pick.minPrice} worth taking (fair odds ${pick.fairOdds.toFixed(2)})`);
      const id = store.addBet(pick, { odds, stake, now });
      console.log(`Logged bet ${id}: ${selection(pick)} @ ${odds} for ${gbp.format(stake)} with ${pick.bookTitle}`);
      return;
    }

    if (command === 'bets') {
      const open = store.open();
      if (!open.length) return console.log('No open bets.');
      for (const b of open) {
        const clv = b.close_prob != null ? `  CLV ${pct(b.odds * b.close_prob - 1)}` : '';
        console.log(`${String(b.id).padStart(4)}  ${when(b.commence_time)}  ${b.home} v ${b.away}: ${selection(b)} @ ${b.odds}  ${gbp.format(b.stake)}  (${b.book})${clv}`);
      }
      return;
    }

    if (command === 'close') {
      const open = store.open().filter((b) => new Date(b.commence_time) > now);
      if (!open.length) return console.log('No open bets before kick-off.');
      const events = await loadEvents(cfg, flags, [...new Set(open.map((b) => b.sport))], now.getTime());
      for (const b of open) {
        const p = currentFairProb(events, b, cfg, now.getTime());
        if (p == null) { console.log(`Bet ${b.id}: no fresh sharp price for this line right now`); continue; }
        store.setClose(b.id, p, now);
        console.log(`Bet ${b.id}: you took ${b.odds}, fair now ${(1 / p).toFixed(2)} → CLV ${pct(b.odds * p - 1)}`);
      }
      return;
    }

    if (command === 'settle') {
      if (args.length === 2) {
        const bet = store.get(Number(args[0]));
        if (!bet) throw new Error(`No bet ${args[0]}`);
        const result = manualResult(bet, args[1]);
        store.settle(bet.id, result, now);
        return console.log(`Bet ${bet.id}: ${result.status} ${gbp.format(result.pnl)}`);
      }
      const { settled, noScores } = await settleFinished(store, cfg, { now, scoresFile: flags.scores });
      for (const r of settled) console.log(`Bet ${r.bet.id}: ${r.bet.home} ${r.home}-${r.away} ${r.bet.away} → ${r.status} ${gbp.format(r.pnl)}`);
      for (const sport of noScores) console.log(`No scores for ${sport}; settle these by hand with "settle <bet> <result>"`);
      if (!settled.length && !noScores.length) console.log('Nothing to settle yet.');
      console.log('Check results against your bookmaker\'s rules (e.g. tennis retirements, extra time, cancelled fights) and fix any with "settle <bet> <result>".');
      return;
    }

    if (command === 'report') {
      const r = report(store.all());
      if (flags.json) return console.log(JSON.stringify(r, null, 2));
      console.log(`Bankroll ${gbp.format(store.bankroll(cfg.bankroll))} (started ${gbp.format(cfg.bankroll)})`);
      console.log(`Bets: ${r.bets} (${r.open} open, ${r.settled} settled)`);
      console.log(`Staked ${gbp.format(r.staked)} · profit ${gbp.format(r.pnl)} · ROI ${pct(r.roi)}`);
      console.log(`Expected profit on settled bets: ${gbp.format(r.expectedPnl)} (average edge at bet time ${pct(r.avgEv)})`);
      if (r.decided) {
        console.log(`\nWin rate ${pct(r.winRate)} (${r.wins} of ${r.decided}) · expected ${pct(r.expectedWinRate)} from fair odds · break-even ${pct(r.breakEvenWinRate)}`);
        console.log(`With ${r.decided} bets the true win rate is likely between ${pct(r.winRateLow, 0)} and ${pct(r.winRateHigh, 0)} (95% range).`);
        if (r.decided < 300) console.log(`It takes about 300 bets to pin a 75% win rate down to ±5%.`);
      }
      if (r.clvCount) {
        console.log(`Closing line value: ${pct(r.avgClv)} average over ${r.clvCount} bets, beat the close ${pct(r.beatClose, 0)} of the time`);
      }
      console.log('\nProfit is mostly luck until you have hundreds of bets. Positive CLV is the early sign the edge is real.');
      return;
    }

    throw new Error(`Unknown command "${command}". Run with no arguments for help.`);
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
