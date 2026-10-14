# edge-finder

Finds sports bets where a bookmaker's price is **better than the true chance of the outcome**, sizes each stake, and tracks whether the edge is real.

## What it can and can't do

No system can find bets that pay big *and* almost always win. Odds already price in the probability: a 1.30 favourite wins about 75% of the time, a 5.00 shot about 19%. Betting on likely outcomes is not an edge; it just means lots of small wins and occasional big losses.

The only edge that holds up is **value**: a price that's too high for the outcome's real probability. edge-finder looks for that:

1. **True probability from the sharp market.** Pinnacle and the Betfair/Matchbook exchanges take bets from professionals and correct their prices quickly, so their odds are the best public estimate of the real chance. edge-finder removes their margin (de-vig) to get a fair probability.
2. **Compare every other bookmaker against it.** Soft books (William Hill, Sky Bet, Paddy Power…) are slower to move and shade prices for marketing. When one is offering, say, 1.53 on something whose fair price is 1.47, that bet has a +3.8% expected return.
3. **Only likely outcomes.** The default `safe` profile only picks outcomes the sharp market rates **at least 75% likely** (odds of about 1.10–1.40), so you should win roughly 3 bets in 4 or better. See [Win rate](#win-rate) for what that does and doesn't prove.
4. **Kelly staking.** Stakes are a quarter of the Kelly-optimal amount, capped at 2% of bankroll per bet. Picks are ranked by expected bankroll growth, which balances the edge against the odds.
5. **Closing line value (CLV).** The honest scorecard. If the prices you take keep beating the sharp price just before kick-off, your edge is real, long before profit/loss can tell you anything.

Expect a +2–5% average return on stakes *if* everything goes right, with big swings. Over 100 bets, luck dominates; over 1,000, the edge shows.

**Tennis retirements:** if a player retires injured, Paddy Power and Betfair Sportsbook each have their own rule for whether the bet stands or is void. Check their rules and settle those bets by hand.

**The practical catch:** soft bookmakers restrict or close accounts that consistently beat them, often within weeks. That is the main limit on this strategy, not the maths.

## Profiles

| | `safe` (default) | `value` |
|---|---|---|
| Win chance | 75%+ | 40%+ |
| Odds | 1.10 – 1.40 | 1.30 – 4.00 |
| Minimum edge | 1.5% | 2% |
| Sports | All tennis tournaments, MMA | EPL, Champions League, NBA, NFL, NHL |
| Market | Match winner only | Match winner, handicaps, over/unders |
| Bookmakers | Paddy Power, Betfair Sportsbook | Any |
| Bankroll | £100, pausing at £70 | £1,000, pausing at £700 |

Choose with `--profile value` or `EDGE_PROFILE=value`. Any setting below overrides the profile.

## Win rate

Picking 75%+ outcomes makes a 75%+ win rate likely, but **win rate on its own doesn't prove the system works**. At odds of 1.25 you need to win 80% just to break even, because each loss costs as much as four wins. So `report` shows three numbers side by side:

- **actual win rate**: how often you won;
- **expected win rate**: what the fair odds said you would win;
- **break-even win rate**: what you needed to win at the prices you took.

The system is working when your actual rate stays near the expected rate *and* above break-even, and your closing line value is positive. The report also gives a 95% range for your true win rate: after 20 bets that range is very wide, and it takes about 300 bets to pin a 75% win rate down to within ±5%.

## Setup: picks on your phone

Twice a day (about 9am and 5pm UK time), GitHub runs a scan for free and sends each new pick to you on Telegram:

> 🎾 **Jannik Sinner to win** @ **1.18** with Paddy Power
> Sinner v Gaston · ATP Paris Masters · Thu 15 Oct, 14:00
> Wins 88% of the time (fair odds 1.14) · break-even 85% · edge +3.9%
> Stake **£2.00** to win £0.36
> [ ✅ Placed ] [ Skip ]

Tap **✅ Placed** once you've placed the bet, and it's logged at that price and stake. Every run also settles finished bets, tells you the results, and sends your bankroll and win rate.

One-off setup, about 15 minutes:

1. **Odds API key.** Sign up free at [the-odds-api.com](https://the-odds-api.com) and copy your key.
2. **Telegram bot.** In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, pick any name, and copy the token it gives you. Then open your new bot and send it any message (e.g. "hi").
3. **Your chat ID.** On a computer with Node.js 22.13+, in this folder: `TELEGRAM_BOT_TOKEN=<token> npm run edge -- telegram-setup`. It prints `TELEGRAM_CHAT_ID=...`. The bot only listens to this chat.
4. **GitHub secrets.** In the repository on GitHub: *Settings → Secrets and variables → Actions → New repository secret*. Add:
   - `ODDS_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `EDGE_DATA_KEY`: any long password you make up. Your bet history is saved encrypted on the `edge-data` branch, because this repository is public. If you lose this password, the history can't be read.
   - Optional: under the *Variables* tab, `EDGE_BANKROLL` if you start with something other than £100.
5. **First run.** *Actions → edge-finder → Run workflow*. Within a minute you should get a summary message on Telegram (and any picks).

After that it runs by itself. The schedule only runs from the repository's default branch.

### Telegram commands

Commands you send are read at the next scheduled run, not instantly.

| Command | What it does |
|---|---|
| `/placed <pick> [odds] [stake]` | Log a pick if you got a different price or stake, e.g. `/placed 3a2fce56 1.16 2` |
| `/result <bet> won\|lost\|void` | Settle a bet by hand. Needed for MMA and some tennis, which have no scores in the API; the bot reminds you |
| `/bets` | Your open bets |
| `/report` | Bankroll, win rate, profit |
| `/resume` | Carry on after the stop-loss paused betting. The new stop is 30% below your bankroll at that point |

### Stop-loss

If your bankroll falls to £70 (30% below the start), picks stop and the bot tells you. Look back over what happened before sending `/resume`. A 30% drop at 75%+ win chances is unlikely to be bad luck alone; it more likely means the prices you're getting aren't the ones the scan found.

### API credits

A run costs 1 credit per competition scanned (each running tennis tournament, plus MMA), plus 2 per competition with a finished bet to settle. Twice a day that is usually 300–450 credits a month, inside the free 500. If you run low, the bot warns you below 60 credits.

## Running it yourself

```bash
npm run demo                            # sample odds, no key needed
export ODDS_API_KEY=your_key
npm run edge -- scan
```

## Command line

```bash
npm run edge -- scan                         # find value bets
npm run edge -- place 1                      # you placed pick #1 at the shown price/stake
npm run edge -- place 2 --odds 1.70 --stake 12   # you got a slightly different price
npm run edge -- close                        # shortly before kick-off: record the closing price
npm run edge -- settle                       # after games: grade from final scores
npm run edge -- report                       # profit, ROI, CLV
```

Before you place a bet, **check the price is still there**: these edges often last only minutes. `place` warns you if the price you got has no edge left. Picks flagged ⚠ have an edge above 15%, which almost always means a stale price or a mismatched line rather than a real mistake by the bookmaker, so they get no stake.

Automatic settlement uses The Odds API's final scores where it has them; MMA and some tennis may need settling by hand. Check results against your bookmaker's rules and correct with `settle <bet id> won|lost|push|void|half-won|half-lost`.

## Settings

Environment variables, or the flag in brackets for one run:

| Variable | Default | Meaning |
|---|---|---|
| `ODDS_API_KEY` | | The Odds API key |
| `EDGE_PROFILE` (`--profile`) | `safe` | `safe` or `value` (see [Profiles](#profiles)) |
| `EDGE_SPORTS` (`--sports`) | from profile | Sport keys; `tennis_*` means every tennis tournament (`npm run edge -- sports` lists them) |
| `EDGE_REGIONS` | `uk,eu` | Odds API regions (`eu` brings Pinnacle, `uk` brings Betfair) |
| `EDGE_MARKETS` | from profile | Match result, handicaps, over/unders |
| `EDGE_BOOKS` (`--books`) | from profile | Only show bets at these bookmakers |
| `EDGE_BANKROLL` (`--bankroll`) | from profile | Starting bankroll in £; stakes use the current bankroll (start plus settled profit) |
| `EDGE_KELLY_FRACTION` | `0.25` | Fraction of full Kelly to stake |
| `EDGE_MAX_STAKE_PCT` | `0.02` | Most of the bankroll on one bet |
| `EDGE_MIN_EDGE` (`--min-edge`) | from profile | Minimum expected return per £1 |
| `EDGE_MAX_EDGE` | `0.15` | Above this, flag as a likely bad line |
| `EDGE_MIN_PROB` (`--min-prob`) | from profile | Minimum fair win chance |
| `EDGE_MIN_ODDS` / `EDGE_MAX_ODDS` | from profile | Odds range |
| `EDGE_STOP_LOSS_PCT` | `0.3` | Pause after the bankroll falls this far (0 = never) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | | For the `run` command |
| `EDGE_MAX_STALE_MINUTES` | `10` | Ignore prices older than this |
| `EDGE_MIN_LEAD_MINUTES` | `5` | Ignore events starting sooner than this |
| `EDGE_DEVIG_METHOD` | `power` | `power`, `shin` or `multiplicative` |
| `EDGE_CONSENSUS` (`--consensus`) | off | With no sharp price, use the median of 5+ books (much weaker) |
| `EDGE_ONE_PER_EVENT` (`--all-per-event`) | on | Only the best bet per match, since bets on the same match are correlated |
| `EDGE_DB` | `edge-finder.db` | SQLite bet log |

## How it works

- `src/devig.js`: margin removal. *Power* (default) and *Shin* take more margin off longshots, matching how bookmakers actually price.
- `src/scanner.js`: groups each match's prices into comparable lines (same handicap/total across books), gets fair probabilities from the sharp books, filters and ranks picks.
- `src/kelly.js`: expected value, Kelly fraction, stake.
- `src/settle.js`: grades bets from scores, including Asian quarter lines.
- `src/store.js`: SQLite bet log, sent picks, bankroll and the report.
- `src/run.js` and `src/telegram.js`: the scheduled job and the Telegram bot.
- `../.github/workflows/edge-finder.yml`: the twice-daily schedule.

`npm test` runs the tests.

## Gambling responsibly

Only bet what you can afford to lose, and check that betting is legal for you where you live (18+ in the UK). If gambling stops being fun, [BeGambleAware](https://www.begambleaware.org) (0808 8020 133) and [GAMSTOP](https://www.gamstop.co.uk) can help.
