# edge-finder

Finds sports bets where a bookmaker's price is **better than the true chance of the outcome**, sizes each stake, and tracks whether the edge is real.

## What it can and can't do

No system can find bets that pay big *and* almost always win. Odds already price in the probability: a 1.30 favourite wins about 75% of the time, a 5.00 shot about 19%. Betting on likely outcomes is not an edge; it just means lots of small wins and occasional big losses.

The only edge that holds up is **value**: a price that's too high for the outcome's real probability. edge-finder looks for that:

1. **True probability from the sharp market.** Pinnacle and the Betfair/Matchbook exchanges take bets from professionals and correct their prices quickly, so their odds are the best public estimate of the real chance. edge-finder removes their margin (de-vig) to get a fair probability.
2. **Compare every other bookmaker against it.** Soft books (William Hill, Sky Bet, Paddy Power…) are slower to move and shade prices for marketing. When one is offering, say, 1.53 on something whose fair price is 1.47, that bet has a +3.8% expected return.
3. **Only likely outcomes**, by default. Picks need a fair win chance of at least 40% and odds between 1.30 and 4.00 (all adjustable). This is the "high likelihood" part: lower variance, at the cost of fewer picks.
4. **Kelly staking.** Stakes are a quarter of the Kelly-optimal amount, capped at 2% of bankroll per bet. Picks are ranked by expected bankroll growth, which balances the edge against the odds.
5. **Closing line value (CLV).** The honest scorecard. If the prices you take keep beating the sharp price just before kick-off, your edge is real, long before profit/loss can tell you anything.

Expect a +2–5% average return on stakes *if* everything goes right, with big swings. Over 100 bets, luck dominates; over 1,000, the edge shows.

**The practical catch:** soft bookmakers restrict or close accounts that consistently beat them, often within weeks. That is the main limit on this strategy, not the maths.

## Setup

Node.js 22.13+. No dependencies to install.

1. Get an API key at [the-odds-api.com](https://the-odds-api.com) (the free tier gives 500 credits a month; a scan costs *markets × regions* credits per sport, so 6 per sport with the defaults).
2. `export ODDS_API_KEY=your_key`
3. `export EDGE_BOOKS=williamhill,skybet,paddypower` with the bookmakers you have accounts with (run a scan without it first to see the keys).

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

Automatic settlement uses The Odds API's final scores. Check them against your bookmaker's rules (extra time, abandoned matches, player withdrawals) and correct with `settle <bet id> won|lost|push|void|half-won|half-lost`.

## Settings

Environment variables, or the flag in brackets for one run:

| Variable | Default | Meaning |
|---|---|---|
| `ODDS_API_KEY` | | The Odds API key |
| `EDGE_SPORTS` (`--sports`) | EPL, Champions League, NBA, NFL, NHL | Sport keys (`npm run edge -- sports` lists them) |
| `EDGE_REGIONS` | `uk,eu` | Odds API regions (`eu` brings Pinnacle, `uk` brings Betfair) |
| `EDGE_MARKETS` | `h2h,spreads,totals` | Match result, handicaps, over/unders |
| `EDGE_BOOKS` (`--books`) | any soft book | Only show bets at these bookmakers |
| `EDGE_BANKROLL` (`--bankroll`) | `1000` | Betting bankroll in £ |
| `EDGE_KELLY_FRACTION` | `0.25` | Fraction of full Kelly to stake |
| `EDGE_MAX_STAKE_PCT` | `0.02` | Most of the bankroll on one bet |
| `EDGE_MIN_EDGE` (`--min-edge`) | `0.02` | Minimum expected return per £1 |
| `EDGE_MAX_EDGE` | `0.15` | Above this, flag as a likely bad line |
| `EDGE_MIN_PROB` (`--min-prob`) | `0.4` | Minimum fair win chance |
| `EDGE_MIN_ODDS` / `EDGE_MAX_ODDS` | `1.3` / `4` | Odds range |
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
