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
  return { data: await res.json(), remaining: res.headers.get('x-requests-remaining') };
}

export function fetchOdds({ apiKey, sport, regions, markets, fetchImpl = fetch }) {
  return get(`/sports/${sport}/odds`, {
    apiKey, regions, markets, oddsFormat: 'decimal', dateFormat: 'iso',
  }, fetchImpl);
}

export function fetchScores({ apiKey, sport, daysFrom = 3, fetchImpl = fetch }) {
  return get(`/sports/${sport}/scores`, { apiKey, daysFrom: String(daysFrom), dateFormat: 'iso' }, fetchImpl);
}

export function fetchSports({ apiKey, fetchImpl = fetch }) {
  return get('/sports', { apiKey }, fetchImpl);
}
