#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { fetchSports } from './odds-api.js';
import { scan, currentFairProb } from './scanner.js';
import { openStore, report } from './store.js';
import { manualResult } from './settle.js';
import { loadEvents as fetchEvents, settleFinished } from './events.js';
import { telegram } from './telegram.js';
import { runOnce } from './run.js';
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
  run                  The scheduled job: Telegram taps/commands, settle, scan, send picks
  telegram-setup       Show your Telegram chat ID (message your bot first)

Scan options (or the env vars in README.md):
  --profile safe|value   safe (default): 75%+ win chance, tennis & MMA, Paddy Power/Betfair Sportsbook
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
    if (['consensus', 'json'].includes(key)) { flags[key] = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    flags[key] = value;
  }
  return { positional, flags };
}

async function loadEvents(cfg, flags, sports = cfg.sports) {
  const { events, remaining, errors } = await fetchEvents(cfg, { sports, fixture: flags.fixture });
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
    console.log(`    edge +${pct(p.ev)}  ·  stake ${gbp.format(p.stake)} to win ${gbp.format(p.stake * (p.odds - 1))}`);
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
    const events = await loadEvents(cfg, flags);
    // Size stakes from the current bankroll, and respect the stop-loss.
    const store = openStore(cfg.db);
    const bankroll = store.bankroll(cfg.bankroll);
    const stopLevel = store.stopLevel(cfg.bankroll, cfg.stopLossPct);
    store.close();
    const live = { ...cfg, bankroll, stopLevel, paused: bankroll <= stopLevel };
    const picks = live.paused ? [] : scan(events, live, now.getTime());
    writeFileSync(LAST_SCAN, JSON.stringify(picks, null, 2));
    if (flags.json) return console.log(JSON.stringify(picks, null, 2));
    return printPicks(picks, live);
  }

  const store = openStore(cfg.db);
  try {
    if (command === 'run') {
      if (!cfg.telegramToken || !cfg.telegramChatId) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (see README)');
      const bot = telegram({ token: cfg.telegramToken, chatId: cfg.telegramChatId });
      const r = await runOnce({ cfg, store, bot, now, fixture: flags.fixture, scoresFile: flags.scores });
      console.log(`Sent ${r.sent} picks, settled ${r.settled} bets, bankroll ${gbp.format(r.bankroll)}${r.paused ? ' (paused)' : ''}`);
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
      if (pick.fairProb * odds - 1 <= 0) console.warn(`Warning: at ${odds} this bet has no edge (fair odds ${pick.fairOdds.toFixed(2)})`);
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
      const events = await loadEvents(cfg, flags, [...new Set(open.map((b) => b.sport))]);
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
