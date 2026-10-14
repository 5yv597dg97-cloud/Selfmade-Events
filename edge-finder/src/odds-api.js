// Thin client for The Odds API v4 (https://the-odds-api.com). Each odds request
// costs (number of markets) x (number of regions) credits from your quota.
const BASE = 'https://api.the-odds-api.com/v4';

async function get(path, params, fetchImpl) {
  const url = new URL(`${BASE}${path}`);
  url.search = new URLSearchParams(params).toString();
  const res = await fetchImpl(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Odds API ${res.status} on ${path}: ${body.slice(0, 300)}`);
  }
  const header = (name) => (res.headers.get(name) == null ? null : Number(res.headers.get(name)));
  // `last` is what this request cost.
  return { data: await res.json(), remaining: header('x-requests-remaining'), last: header('x-requests-last') };
}

/**
 * Naming up to 10 bookmakers costs the same as one region, which is far cheaper
 * than the two regions needed to cover Pinnacle and the UK books.
 */
export function fetchOdds({ apiKey, sport, regions, bookmakers, markets, fetchImpl = fetch }) {
  const where = bookmakers?.length ? { bookmakers: bookmakers.slice(0, 10).join(',') } : { regions };
  return get(`/sports/${sport}/odds`, {
    apiKey, ...where, markets, oddsFormat: 'decimal', dateFormat: 'iso',
  }, fetchImpl);
}

/** Upcoming matches without odds. Free: doesn't use any quota. */
export function fetchEvents({ apiKey, sport, fetchImpl = fetch }) {
  return get(`/sports/${sport}/events`, { apiKey, dateFormat: 'iso' }, fetchImpl);
}

export function fetchScores({ apiKey, sport, daysFrom = 3, fetchImpl = fetch }) {
  return get(`/sports/${sport}/scores`, { apiKey, daysFrom: String(daysFrom), dateFormat: 'iso' }, fetchImpl);
}

export function fetchSports({ apiKey, fetchImpl = fetch }) {
  return get('/sports', { apiKey }, fetchImpl);
}
