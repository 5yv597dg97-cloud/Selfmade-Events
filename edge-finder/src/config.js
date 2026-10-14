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
  devigMethod: 'power',
  consensus: false,
  minConsensusBooks: 5,
  onePerEvent: true,
  db: 'edge-finder.db',
};

// Presets that sit between the defaults and your own settings. "safe" chases a
// high win rate: only outcomes the sharp market rates 75%+ likely, which means
// short odds and small wins. "value" takes any odds with an edge.
export const PROFILES = {
  safe: {
    sports: 'tennis_*,mma_mixed_martial_arts',
    markets: 'h2h',
    books: 'paddypower,betfair_sb_uk',
    bankroll: 250,
    minProb: 0.75,
    minOdds: 1.1,
    maxOdds: 1.4,
    minEdge: 0.015,
  },
  value: {},
};

const ENV = {
  apiKey: 'ODDS_API_KEY', sports: 'EDGE_SPORTS', regions: 'EDGE_REGIONS', markets: 'EDGE_MARKETS',
  books: 'EDGE_BOOKS', bankroll: 'EDGE_BANKROLL', kellyFraction: 'EDGE_KELLY_FRACTION',
  maxStakePct: 'EDGE_MAX_STAKE_PCT', minEdge: 'EDGE_MIN_EDGE', maxEdge: 'EDGE_MAX_EDGE',
  minProb: 'EDGE_MIN_PROB', minOdds: 'EDGE_MIN_ODDS', maxOdds: 'EDGE_MAX_ODDS',
  maxStaleMinutes: 'EDGE_MAX_STALE_MINUTES', minLeadMinutes: 'EDGE_MIN_LEAD_MINUTES',
  devigMethod: 'EDGE_DEVIG_METHOD', consensus: 'EDGE_CONSENSUS',
  minConsensusBooks: 'EDGE_MIN_CONSENSUS_BOOKS', onePerEvent: 'EDGE_ONE_PER_EVENT', db: 'EDGE_DB',
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
  if (cfg.maxStakePct <= 0 || cfg.maxStakePct > 0.1) throw new Error('Max stake must be in (0, 0.1] of bankroll');
  return cfg;
}
