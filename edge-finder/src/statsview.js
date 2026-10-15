// The results-based model's view of upcoming league matches, for information.
// The backtest showed it is less accurate than the market and does not improve
// picks, so it never filters anything; it is only shown alongside.
import { loadHistory, seasonCode } from './history.js';
import { fitRatings, predict } from './ratings.js';
import { matchTeam } from './teams.js';

export const SPORT_LEAGUE = {
  soccer_epl: 'E0', soccer_efl_champ: 'E1', soccer_spain_la_liga: 'SP1', soccer_italy_serie_a: 'I1',
  soccer_germany_bundesliga: 'D1', soccer_france_ligue_one: 'F1', soccer_netherlands_eredivisie: 'N1',
  soccer_portugal_primeira_liga: 'P1', soccer_belgium_first_div: 'B1', soccer_spl: 'SC0',
};

/** Fitted ratings for the leagues these events belong to, from this season and last. */
export async function ratingsFor(events, now, { history } = {}) {
  const leagues = [...new Set(events.map((e) => SPORT_LEAGUE[e.sport_key]).filter(Boolean))];
  if (!leagues.length) return {};
  const matches = history ?? await loadHistory({ leagues, seasons: [seasonCode(now, 1), seasonCode(now)], now });
  return Object.fromEntries(leagues.map((l) => [l, fitRatings(matches.filter((m) => m.league === l), now, { halfLifeDays: 365 })]));
}

/** { home, draw, away } from the stats model, or null if it can't rate this match. */
export function statsFor(event, ratings) {
  const r = ratings[SPORT_LEAGUE[event.sport_key]];
  if (!r) return null;
  const known = Object.keys(r.att);
  const home = matchTeam(event.home_team, known);
  const away = matchTeam(event.away_team, known);
  return home && away ? predict(r, home, away) : null;
}
