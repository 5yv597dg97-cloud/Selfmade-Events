// Every setting can come from an environment variable or a CLI flag (flags win).

// Books whose prices are treated as the truth. Pinnacle takes sharp action and
// moves its lines rather than limiting winners; exchanges are set by bettors.
export const SHARP_BOOKS = ['pinnacle', 'betfair_ex_uk', 'betfair_ex_eu', 'matchbook'];

const DEFAULTS = {
  apiKey: '',
  sports: 'soccer_epl,soccer_uefa_champs_league,basketball_nba,americanfootball_nfl,icehockey_nhl',
  regions: 'uk,eu',
  markets: 'h2h,spreads,totals',
  books: '', // comma-separated bookmaker keys you hold accounts with; empty = any non-sharp book
  bankroll: 1000,
  kellyFraction: 0.25,
  maxStakePct: 0.02,
  minEdge: 0.02,
  maxEdge: 0.15,
  minProb: 0.4,
  minOdds: 1.3,
  maxOdds: 4,
  maxStaleMinutes: 10,
  minLeadMinutes: 5,
  lookaheadHours: 48, // only pay to scan competitions with a match starting within this window
  devigMethod: 'power',
  consensus: false,
  minConsensusBooks: 5,
  onePerEvent: true,
  maxPicksPerDay: 0, // 0 = no limit
  doubles: false,
  doubleStake: 0.2,
  doublesPerWeek: 5,
  doubleMinOdds: 51, // 50/1
  doubleMaxOdds: 151, // 150/1
  doubleMinEdge: 0.05,
  legMinEdge: 0.02,
  legMinOdds: 1.5,
  legMaxOdds: 40,
  trixies: false,
  trixieUnitStake: 0.5, // per line; a trixie is 4 lines
  trixiesPerWeek: 2,
  trixieLegMinProb: 0.75,
  trixieLegMinEdge: 0, // each leg priced at least fair
  trixieLegMaxOdds: 1.6,
  trixieMinEdge: 0.02, // the whole trixie at least 2% above fair
  banker: false,
  bankerUnitStake: 0.5,
  bankerWindowHours: 72, // matches starting within this long of the Friday scan
  scorelines: false,
  footballMarkets: 'h2h,totals', // totals feed the scoreline model; costs 1 extra credit per league scan
  scorelineLegEdge: 0.05, // a scoreline is only worth backing at least this far above its fair price
  scorelineTopN: 4, // likeliest scorelines per match to consider
  scorelineTarget: 100, // aim for doubles near 99/1
  creditBudget: true, // spread the month's API credits evenly over the remaining runs
  runsPerDay: 2,
  stopLossPct: 0.3, // pause once the bankroll has fallen this far from its starting point
  telegramToken: '',
  telegramChatId: '',
  db: 'edge-finder.db',
};

// Presets that sit between the defaults and your own settings. "safe" chases a
// high win rate: only outcomes the sharp market rates 75%+ likely, which means
// short odds and small wins. "value" takes any odds with an edge.
export const PROFILES = {
  safe: {
    // In priority order: when credits are rationed, the first ones are scanned first.
    sports: 'tennis_*,mma_mixed_martial_arts,soccer_epl,soccer_uefa_champs_league,soccer_spain_la_liga,'
      + 'soccer_italy_serie_a,soccer_germany_bundesliga,basketball_nba,americanfootball_nfl,icehockey_nhl,'
      + 'rugbyunion_*,rugbyleague_*,cricket_*',
    markets: 'h2h',
    books: 'paddypower,betfair_sb_uk,coral,ladbrokes_uk,betway',
    bankroll: 100,
    minProb: 0.75,
    minOdds: 1.1,
    maxOdds: 1.4,
    minEdge: 0.015,
    maxPicksPerDay: 5,
    doubles: true,
    scorelines: true,
    trixies: true,
    banker: true,
  },
  value: {},
};

const ENV = {
  apiKey: 'ODDS_API_KEY', sports: 'EDGE_SPORTS', regions: 'EDGE_REGIONS', markets: 'EDGE_MARKETS',
  books: 'EDGE_BOOKS', bankroll: 'EDGE_BANKROLL', kellyFraction: 'EDGE_KELLY_FRACTION',
  maxStakePct: 'EDGE_MAX_STAKE_PCT', minEdge: 'EDGE_MIN_EDGE', maxEdge: 'EDGE_MAX_EDGE',
  minProb: 'EDGE_MIN_PROB', minOdds: 'EDGE_MIN_ODDS', maxOdds: 'EDGE_MAX_ODDS',
  maxStaleMinutes: 'EDGE_MAX_STALE_MINUTES', minLeadMinutes: 'EDGE_MIN_LEAD_MINUTES',
  lookaheadHours: 'EDGE_LOOKAHEAD_HOURS', maxPicksPerDay: 'EDGE_MAX_PICKS_PER_DAY',
  doubles: 'EDGE_DOUBLES', doubleStake: 'EDGE_DOUBLE_STAKE', doublesPerWeek: 'EDGE_DOUBLES_PER_WEEK',
  doubleMinOdds: 'EDGE_DOUBLE_MIN_ODDS', doubleMaxOdds: 'EDGE_DOUBLE_MAX_ODDS', doubleMinEdge: 'EDGE_DOUBLE_MIN_EDGE',
  legMinEdge: 'EDGE_LEG_MIN_EDGE', legMinOdds: 'EDGE_LEG_MIN_ODDS', legMaxOdds: 'EDGE_LEG_MAX_ODDS',
  trixies: 'EDGE_TRIXIES', trixieUnitStake: 'EDGE_TRIXIE_UNIT_STAKE', trixiesPerWeek: 'EDGE_TRIXIES_PER_WEEK',
  trixieLegMinProb: 'EDGE_TRIXIE_LEG_MIN_PROB', trixieLegMinEdge: 'EDGE_TRIXIE_LEG_MIN_EDGE',
  trixieLegMaxOdds: 'EDGE_TRIXIE_LEG_MAX_ODDS', trixieMinEdge: 'EDGE_TRIXIE_MIN_EDGE',
  banker: 'EDGE_BANKER', bankerUnitStake: 'EDGE_BANKER_UNIT_STAKE', bankerWindowHours: 'EDGE_BANKER_WINDOW_HOURS',
  scorelines: 'EDGE_SCORELINES', footballMarkets: 'EDGE_FOOTBALL_MARKETS', scorelineLegEdge: 'EDGE_SCORELINE_LEG_EDGE',
  scorelineTopN: 'EDGE_SCORELINE_TOP_N', scorelineTarget: 'EDGE_SCORELINE_TARGET',
  creditBudget: 'EDGE_CREDIT_BUDGET', runsPerDay: 'EDGE_RUNS_PER_DAY',
  devigMethod: 'EDGE_DEVIG_METHOD', consensus: 'EDGE_CONSENSUS',
  minConsensusBooks: 'EDGE_MIN_CONSENSUS_BOOKS', onePerEvent: 'EDGE_ONE_PER_EVENT', db: 'EDGE_DB',
  stopLossPct: 'EDGE_STOP_LOSS_PCT', telegramToken: 'TELEGRAM_BOT_TOKEN', telegramChatId: 'TELEGRAM_CHAT_ID',
};

const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const list = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);

export function loadConfig(env = process.env, flags = {}) {
  const profile = flags.profile ?? env.EDGE_PROFILE ?? 'safe';
  const preset = PROFILES[profile];
  if (!preset) throw new Error(`Unknown profile "${profile}" (use ${Object.keys(PROFILES).join(' or ')})`);
  const cfg = { profile };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    let value = flags[kebab(key)] ?? env[ENV[key]] ?? preset[key] ?? fallback;
    if (typeof fallback === 'number') {
      value = Number(value);
      if (!Number.isFinite(value)) throw new Error(`--${kebab(key)} must be a number`);
    } else if (typeof fallback === 'boolean') {
      value = value === true || ['1', 'true', 'yes'].includes(String(value).toLowerCase());
    }
    cfg[key] = value;
  }
  cfg.sports = list(cfg.sports);
  cfg.books = list(cfg.books);
  cfg.marketList = list(cfg.markets);
  if (cfg.kellyFraction <= 0 || cfg.kellyFraction > 1) throw new Error('Kelly fraction must be in (0, 1]');
  if (cfg.stopLossPct < 0 || cfg.stopLossPct >= 1) throw new Error('Stop-loss must be in [0, 1)');
  if (cfg.maxStakePct <= 0 || cfg.maxStakePct > 0.1) throw new Error('Max stake must be in (0, 0.1] of bankroll');
  return cfg;
}
