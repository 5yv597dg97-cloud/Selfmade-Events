#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { fetchOdds, fetchScores, fetchSports } from './odds-api.js';
import { scan, currentFairProb } from './scanner.js';
import { openStore, report } from './store.js';
import { grade, manualResult } from './settle.js';

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

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const when = (iso) => new Date(iso).toLocaleString('en-GB', {
  timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

function selection(p) {
  if (p.market === 'h2h') return p.outcome === 'Draw' ? 'Draw' : `${p.outcome} to win`;
  const pt = p.point > 0 && p.market === 'spreads' ? `+${p.point}` : p.point;
  return `${p.outcome} ${pt}`;
}

async function loadEvents(cfg, flags, sports = cfg.sports) {
  if (flags.fixture) return JSON.parse(readFileSync(flags.fixture, 'utf8'));
  if (!cfg.apiKey) throw new Error('Set ODDS_API_KEY (free key at https://the-odds-api.com) or use --fixture');
  const events = [];
  let remaining;
  for (const sport of await expandSports(cfg, sports)) {
    try {
      const res = await fetchOdds({ apiKey: cfg.apiKey, sport, regions: cfg.regions, markets: cfg.markets });
      events.push(...res.data);
      remaining = res.remaining;
    } catch (err) {
      console.error(`  ! ${sport}: ${err.message}`);
    }
  }
  if (remaining != null) console.error(`  (Odds API credits left: ${remaining})`);
  return events;
}

/** Turns "tennis_*" into every tennis competition currently open (the sports list costs no credits). */
async function expandSports(cfg, sports) {
  if (!sports.some((s) => s.endsWith('*'))) return sports;
  const { data } = await fetchSports({ apiKey: cfg.apiKey });
  const active = data.filter((s) => s.active && !s.has_outrights).map((s) => s.key);
  const out = sports.flatMap((s) => (s.endsWith('*') ? active.filter((k) => k.startsWith(s.slice(0, -1))) : [s]));
  console.error(`  Scanning ${out.length} competitions: ${out.join(', ')}`);
  return [...new Set(out)];
}

function printPicks(picks, cfg) {
  if (!picks.length) {
    console.log('No value bets right now. That is the normal state of an efficient market; check again later.');
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

  if (command === 'scan') {
    const events = await loadEvents(cfg, flags);
    const picks = scan(events, cfg, now.getTime());
    writeFileSync(LAST_SCAN, JSON.stringify(picks, null, 2));
    if (flags.json) return console.log(JSON.stringify(picks, null, 2));
    return printPicks(picks, cfg);
  }

  const store = openStore(cfg.db);
  try {
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
      const open = store.open().filter((b) => new Date(b.commence_time) < now);
      if (!open.length) return console.log('No open bets that have started.');
      for (const sport of new Set(open.map((b) => b.sport))) {
        let games;
        try {
          games = flags.scores
            ? JSON.parse(readFileSync(flags.scores, 'utf8'))
            : (await fetchScores({ apiKey: cfg.apiKey, sport })).data;
        } catch (err) {
          console.log(`No scores for ${sport} (${err.message}); settle these by hand with "settle <bet> <result>"`);
          continue;
        }
        for (const b of open.filter((x) => x.sport === sport)) {
          const g = games.find((x) => x.id === b.event_id);
          if (!g?.completed || !g.scores) continue;
          const score = (team) => Number(g.scores.find((s) => s.name === team)?.score);
          const [h, a] = [score(b.home), score(b.away)];
          if (!Number.isFinite(h) || !Number.isFinite(a)) continue;
          const result = grade(b, h, a);
          store.settle(b.id, result, now);
          console.log(`Bet ${b.id}: ${b.home} ${h}-${a} ${b.away} → ${result.status} ${gbp.format(result.pnl)}`);
        }
      }
      console.log('Check results against your bookmaker\'s rules (e.g. tennis retirements, extra time, cancelled fights) and fix any with "settle <bet> <result>".');
      return;
    }

    if (command === 'report') {
      const r = report(store.all());
      if (flags.json) return console.log(JSON.stringify(r, null, 2));
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
