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
| Bankroll | £250 | £1,000 |

Choose with `--profile value` or `EDGE_PROFILE=value`. Any setting below overrides the profile.

## Win rate

Picking 75%+ outcomes makes a 75%+ win rate likely, but **win rate on its own doesn't prove the system works**. At odds of 1.25 you need to win 80% just to break even, because each loss costs as much as four wins. So `report` shows three numbers side by side:

- **actual win rate**: how often you won;
- **expected win rate**: what the fair odds said you would win;
- **break-even win rate**: what you needed to win at the prices you took.

The system is working when your actual rate stays near the expected rate *and* above break-even, and your closing line value is positive. The report also gives a 95% range for your true win rate: after 20 bets that range is very wide, and it takes about 300 bets to pin a 75% win rate down to within ±5%.

## Setup

Node.js 22.13+. No dependencies to install.

1. Get an API key at [the-odds-api.com](https://the-odds-api.com) (the free tier gives 500 credits a month; a scan costs *markets × regions* credits per sport, so 6 per sport with the defaults).
2. `export ODDS_API_KEY=your_key`
3. Optional: `export EDGE_BANKROLL=300` (your betting bankroll in £). The `safe` profile already uses Paddy Power (`paddypower`) and Betfair Sportsbook (`betfair_sb_uk`); set `EDGE_BOOKS` to change them.

Credits: `tennis_*` scans every tennis tournament that's running (finding them is free). With match-winner only and two regions, each tournament or MMA costs 2 credits per scan, so a typical scan of 4–6 competitions uses about 10 credits: roughly 50 scans a month on the free tier.

Try it with no key using sample odds:

```bash
npm run demo
```

## Daily use

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
| `EDGE_BANKROLL` (`--bankroll`) | from profile | Betting bankroll in £ |
| `EDGE_KELLY_FRACTION` | `0.25` | Fraction of full Kelly to stake |
| `EDGE_MAX_STAKE_PCT` | `0.02` | Most of the bankroll on one bet |
| `EDGE_MIN_EDGE` (`--min-edge`) | from profile | Minimum expected return per £1 |
| `EDGE_MAX_EDGE` | `0.15` | Above this, flag as a likely bad line |
| `EDGE_MIN_PROB` (`--min-prob`) | from profile | Minimum fair win chance |
| `EDGE_MIN_ODDS` / `EDGE_MAX_ODDS` | from profile | Odds range |
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
- `src/store.js`: SQLite bet log and the report.

`npm test` runs the tests.

## Gambling responsibly

Only bet what you can afford to lose, and check that betting is legal for you where you live (18+ in the UK). If gambling stops being fun, [BeGambleAware](https://www.begambleaware.org) (0808 8020 133) and [GAMSTOP](https://www.gamstop.co.uk) can help.
