import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { loadEvents, runBudget } from '../src/events.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');

/** A fake Odds API. `idle` sports have nothing for a week; every odds call costs 1 credit. */
function fakeApi({ remaining = 480, active, idle = [] }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const sport = url.pathname.split('/')[3];
    const headers = { 'x-requests-remaining': String(remaining), 'x-requests-last': '0' };
    if (url.pathname.endsWith('/sports')) {
      return Response.json(active.map((key) => ({ key, active: true })).concat({ key: 'americanfootball_nfl', active: false }), { headers });
    }
    if (url.pathname.endsWith('/events')) {
      const days = idle.includes(sport) ? 7 : 1;
      return Response.json([{ commence_time: new Date(NOW + days * 864e5).toISOString() }], { headers });
    }
    remaining -= 1;
    return Response.json([{ id: sport }], { headers: { 'x-requests-remaining': String(remaining), 'x-requests-last': '1' } });
  };
  return { calls, fetchImpl, odds: () => calls.filter((u) => u.pathname.endsWith('/odds')) };
}

test('expands wildcards, drops out-of-season sports, skips idle ones, and names the bookmakers', async () => {
  const api = fakeApi({
    active: ['tennis_atp_paris_masters', 'tennis_wta_finals', 'mma_mixed_martial_arts', 'soccer_epl', 'cricket_test_match', 'basketball_nba'],
    idle: ['mma_mixed_martial_arts'],
  });
  const cfg = loadConfig({ ODDS_API_KEY: 'k' }, {});
  const r = await loadEvents(cfg, { now: NOW, fetchImpl: api.fetchImpl });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.skipped, ['mma_mixed_martial_arts']);
  // Priority order from the profile; NFL is out of season so never requested.
  assert.deepEqual(api.odds().map((u) => u.pathname.split('/')[3]),
    ['tennis_atp_paris_masters', 'tennis_wta_finals', 'soccer_epl', 'basketball_nba', 'cricket_test_match']);
  for (const u of api.odds()) {
    assert.equal(u.searchParams.get('bookmakers'), 'pinnacle,betfair_ex_uk,paddypower,betfair_sb_uk,coral,ladbrokes_uk,betway');
    assert.equal(u.searchParams.get('regions'), null);
    // Football also fetches total goals, for the scoreline model.
    assert.equal(u.searchParams.get('markets'), u.pathname.includes('/soccer_') ? 'h2h,totals' : 'h2h');
  }
  assert.equal(r.remaining, 475);
  assert.equal(r.events.length, 5);
});

test('stops at the run budget, leaving lower-priority sports for later', async () => {
  // 70 credits with 35 runs left this month: 2 per run, minus 1 kept back = 1.
  const api = fakeApi({ remaining: 70, active: ['tennis_atp_paris_masters', 'soccer_epl', 'basketball_nba'] });
  const r = await loadEvents(loadConfig({ ODDS_API_KEY: 'k' }, {}), { now: NOW, fetchImpl: api.fetchImpl });
  assert.equal(r.budget, 1);
  assert.deepEqual(api.odds().map((u) => u.pathname.split('/')[3]), ['tennis_atp_paris_masters']);
  assert.deepEqual(r.overBudget, ['soccer_epl', 'basketball_nba']);
});

test('the budget spreads credits over the rest of the month', () => {
  assert.equal(runBudget(496, NOW, 2), 13); // 17.5 days left: 35 runs
  assert.equal(runBudget(30, Date.parse('2026-10-30T12:00:00Z'), 2), 9); // 3 runs left
  assert.equal(runBudget(0, NOW, 2), 0);
  assert.equal(runBudget(null, NOW, 2), Infinity);
});
