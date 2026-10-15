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
| Sports | Tennis, MMA, Premier League, Champions League, La Liga, Serie A, Bundesliga, NBA, NFL, NHL, rugby, cricket (in that priority order) | EPL, Champions League, NBA, NFL, NHL |
| Market | Match winner only | Match winner, handicaps, over/unders |
| Bookmakers | Paddy Power, Betfair Sportsbook, Coral, Ladbrokes, Betway | Any |
| Picks per day | 5 at most | No limit |
| Fun doubles | Up to 5 a week, £0.20 each | Off |
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
> Still worth it at **1.16** or better; skip if the price has dropped below that.
> [ ✅ Placed ] [ Skip ]

Tap **✅ Placed** once you've placed the bet, and it's logged at that price and stake. Every run also settles finished bets, tells you the results, and sends your bankroll and win rate.

One-off setup, about 15 minutes, all doable on a phone:

1. **Odds API key.** Sign up free at [the-odds-api.com](https://the-odds-api.com) and copy your key.
2. **Telegram bot.** In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, pick any name and an unusual username, and copy the token it gives you. Then open your new bot and send it any message (e.g. "hi"). The first person to message the bot becomes its owner, so do this straight away.
3. **GitHub secrets.** In the repository on GitHub: *Settings → Secrets and variables → Actions → New repository secret*. Add:
   - `ODDS_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `EDGE_DATA_KEY`: any long password you make up. Your bet history is saved encrypted on the `edge-data` branch, because this repository is public. If you lose this password, the history can't be read.
   - Optional: under the *Variables* tab, `EDGE_BANKROLL` if you start with something other than £100.
4. **First run.** *Actions → edge-finder → Run workflow*. Within a minute your bot should reply "Linked to this chat", followed by a summary and any picks. From then on it only talks to you.

(On a computer you can instead set a `TELEGRAM_CHAT_ID` secret; `npm run edge -- telegram-setup` prints it.)

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

### Limits

- **5 picks a day at most.** The best ones go first; any others are held back and can still go out the next day if they're still good value.
- **The lowest price worth taking** is on every pick. Prices often drop before you see a pick; if yours is below that number, skip it.
- **Each bet is at most 2% of your bankroll.**

### Stop-loss

If your bankroll falls to £70 (30% below the start), picks stop and the bot tells you. Look back over what happened before sending `/resume`. A 30% drop at 75%+ win chances is unlikely to be bad luck alone; it more likely means the prices you're getting aren't the ones the scan found.

### API credits

Scanning a competition costs 1 credit, and settling bets costs 2 per competition. All the sports together would need about 800 credits a month, more than the free 500, so credits are **rationed**:

- Each run spends an even share of the credits left this month (e.g. with 496 left and 35 runs to go, 13 per run), keeping one back for settling bets.
- Sports are scanned in priority order: tennis, MMA, Premier League, the other football leagues, NBA, NFL, NHL, rugby, cricket. When a run's share is used up, the rest wait for the next run.
- Out-of-season sports, and competitions with no match in the next 48 hours, are skipped for free.

So on a busy weekend the lower-priority sports may not get scanned every time. The GitHub run log shows the budget and what was left out. If you move to a paid API plan, everything gets scanned every time with no other change. The budget assumes credits reset at the start of each month; set `EDGE_CREDIT_BUDGET=false` to turn rationing off.

### Fun doubles

As well as the singles, the bot sends up to 5 **fun doubles** a week: two selections from different matches, combined at odds between 50/1 and 150/1 at one bookmaker.

> 🎲 **Fun double** @ **66.3** (65/1) with Paddy Power
> 1. 🎾 Arthur Fils to win @ 5.1 · Alcaraz v Fils
> 2. ⚽ Wolverhampton Wanderers to win @ 13 · Man City v Wolves
> Wins about 1 in 59 · edge +12%
> Stake **£0.20** to win £13.06

- **Both legs must be good value.** Each is priced at least 2% above its fair odds, and the double at least 5%, so the double is good value too: the two edges multiply.
- **They lose most of the time.** A 65/1 double wins about 1 time in 60, so runs of 100+ losses are normal. That's why the stake is a fixed £0.20 rather than a share of your bankroll.
- **They're tracked separately.** Doubles don't count toward your win rate; `/report` shows them on their own line. Their profit and loss does count toward your bankroll and the stop-loss.
- **Placing one:** add both selections to the bookmaker's bet slip and choose *Double*, then tap ✅ Placed. They settle automatically once both matches finish (or reply `/result D1 won|lost|void`). A void leg is settled at odds of 1, as bookmakers do.
- **Settings:** `EDGE_DOUBLES=false` turns them off. `EDGE_DOUBLE_STAKE`, `EDGE_DOUBLES_PER_WEEK`, `EDGE_DOUBLE_MIN_ODDS` and `EDGE_DOUBLE_MAX_ODDS` (decimal; 50/1 is 51) change the rest.

They use the odds already downloaded for the singles, so they cost no extra API credits.

### Scoreline doubles

The bot also suggests **correct-score doubles** near 99/1, for example *Man City 1-0 Wolves + Arsenal 1-0 Everton*. They share the 5-a-week doubles allowance and £0.20 stake; value doubles go first, and scoreline doubles fill any room left.

> 🎲⚽ **Scoreline double**, about 98/1 or better
> 1. **Manchester City 1-0 Wolverhampton Wanderers**: chance 9.8% (fair odds 10.20) · **only at 10.68 or better**
> 2. **Arsenal 1-0 Everton**: chance 11.4% (fair odds 8.80) · **only at 9.25 or better**

**How the fair odds are worked out:** from the sharp market's match result and total goals prices, the bot fits each team's expected goals, then uses a standard football model (Poisson, with the Dixon-Coles adjustment that makes 0-0 and 1-1 a little likelier) to get the chance of every scoreline. It considers each match's 4 likeliest scorelines.

**You have to check the prices yourself.** The odds data doesn't include bookmakers' correct-score prices, so each leg shows the lowest price worth taking (5% above fair). Only bet if your bookmaker offers at least that on **both** scorelines. Bookmakers take big margins on correct scores, so most of the time they won't: skip those. If you place one at a better combined price, log it with `/placed <pick> <combined odds>`.

They settle automatically on the exact final score. Turning them off: `EDGE_SCORELINES=false`. Fetching total goals costs 1 extra credit per football league scan, which the credit budget accounts for.

### Trixies

Up to 2 a week, the bot sends a **trixie**: 3 selections from different matches at one bookmaker, staked as 4 bets (3 doubles + 1 treble) at £0.50 a line, £2 in all. Any 2 winners pay something back.

> 🎯 **Trixie** with Paddy Power
> 1. 🎾 **Jannik Sinner to win** @ 1.18 (min 1.14) · 88%
> 2. ⚽ **Liverpool to win** @ 1.27 (min 1.24) · 81%
> 3. 🥊 **Islam Makhachev to win** @ 1.28 (min 1.27) · 79%
> All 3 win (56%) · 2 of 3 win (36%) · 0 or 1 win (8%)
> Returns something 92% of the time · edge +6%

- **Each leg is a 75%+ chance priced at least fair**, and the trixie as a whole at least 2% above fair. Good-value legs make every line good value.
- **They are rare**, because three such legs have to line up at the same bookmaker.
- **Placing one:** add the three selections to the bet slip, choose *Trixie*, enter £0.50 a line, then tap ✅ Placed.
- **Settling:** automatic from scores where available. Otherwise settle each leg with `/leg D3 1 won` (leg numbers as in the message), or the whole trixie with `/result D3 won|lost|void`.
- **Tracked separately** from your singles win rate; `/report` shows trixies on their own line.
- Settings: `EDGE_TRIXIES=false` turns them off; `EDGE_TRIXIE_UNIT_STAKE`, `EDGE_TRIXIES_PER_WEEK`, `EDGE_TRIXIE_LEG_MIN_PROB` change the rest.

### Banker trixie

Once a week, from the Friday scan, the bot sends a **banker trixie**: the 3 biggest football favourites starting in the next 3 days, at whichever of your bookmakers prices those three best. £0.50 a line, £2 in all.

This is **not a value bet**. It's based on a test over 103 real weeks (10,367 matches, 10 European leagues), with a trixie of the week's 3 biggest favourites every week:

| | Bet365 prices | Best price anywhere |
|---|---|---|
| All 3 won | 60% of weeks | 60% |
| Paid something back | 96% of weeks | 96% |
| Longest run with nothing back | 1 week | 1 week |
| Profit on £206 staked | −£7.57 | +£0.40 |

So it pays something back almost every week and costs roughly nothing over time: steady entertainment rather than profit. The message shows its value against fair prices so you can see when a weekend's prices are poor. `EDGE_BANKER=false` turns it off. Run the test yourself with the workflow's **trixie-test** mode.

### Stats model (for information)

Previews of league football also show a **stats model** built only from past results: each team's attack and defence (home and away, recent matches counting most), from free [football-data.co.uk](https://www.football-data.co.uk) data.

It was **tested before being added**. Over 4,770 matches in 10 European leagues across the 2024/25 and 2025/26 seasons, rated one matchday at a time using only earlier results:

| | Log loss (lower is better) |
|---|---|
| Market (Pinnacle odds) | 0.970 |
| Stats model | 0.991 |
| Market + 10% stats | 0.970 (no better) |

Using it as a filter on value bets also made results worse. So it is **shown for interest and never used to choose or block picks**. The market already includes form, home advantage and head-to-heads, plus team news the results can't see. Run the test again any time with the workflow's **backtest** mode.

### Bookmakers

Picks come from Paddy Power, Betfair Sportsbook, Coral, Ladbrokes and Betway. Up to 10 bookmakers (including Pinnacle and the Betfair Exchange) cost the same single credit per scan, so there's room for 3 more at no cost. Paddy Power and Betfair Sportsbook are one company (Flutter), as are Coral and Ladbrokes (Entain), so a restriction at one can follow you to its sister brand. Betfred isn't covered by The Odds API, so it can't be scanned. If a bookmaker never appears in the odds data, the bot tells you once.

### Football

Football picks are **match winner only** (home win or away win; the draw counts as a loss), on sides the sharp market rates at least 75% to win, in the Premier League, Champions League, La Liga, Serie A and Bundesliga. They settle automatically from the final score after 90 minutes plus stoppage time.

Cricket results don't come through as simple scores, so the bot asks you to settle cricket bets with `/result`.

Player props (goalscorers, shots, cards) aren't included. There's no reliable sharp price to compare them against, bookmakers take their biggest margins on them, few reach 75%, and each one costs credits per match instead of per league.

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
| `TELEGRAM_BOT_TOKEN` | | For the `run` command |
| `TELEGRAM_CHAT_ID` | first chat to message the bot | Who gets the picks |
| `EDGE_MAX_PICKS_PER_DAY` | from profile | Most picks sent per UK day (0 = no limit) |
| `EDGE_CREDIT_BUDGET` | `true` | Ration API credits evenly over the month |
| `EDGE_RUNS_PER_DAY` | `2` | Scheduled runs a day, for the rationing |
| `EDGE_MAX_STALE_MINUTES` | `10` | Ignore prices older than this |
| `EDGE_MIN_LEAD_MINUTES` | `5` | Ignore events starting sooner than this |
| `EDGE_LOOKAHEAD_HOURS` | `48` | Only scan competitions with a match starting within this window |
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
