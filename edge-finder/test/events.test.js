import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { loadEvents } from '../src/events.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');

test('expands tennis_*, skips idle competitions, and names the bookmakers to save credits', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const sport = url.pathname.split('/')[3];
    if (url.pathname.endsWith('/events')) {
      // MMA has nothing for a week; everything else plays tomorrow.
      const days = sport.startsWith('mma') ? 7 : 1;
      return Response.json([{ commence_time: new Date(NOW + days * 864e5).toISOString() }]);
    }
    const body = url.pathname.endsWith('/sports')
      ? [
        { key: 'tennis_atp_paris_masters', active: true },
        { key: 'tennis_wta_finals', active: true },
        { key: 'tennis_atp_aus_open', active: false },
        { key: 'soccer_epl', active: true },
      ]
      : [{ id: url.pathname }];
    return new Response(JSON.stringify(body), { headers: { 'x-requests-remaining': '480' } });
  };
  const cfg = loadConfig({ ODDS_API_KEY: 'k' }, {});
  const { events, remaining, errors, skipped } = await loadEvents(cfg, { now: NOW, fetchImpl });
  assert.deepEqual(errors, []);
  assert.deepEqual(skipped, ['mma_mixed_martial_arts']);
  assert.equal(remaining, 480);
  const odds = calls.filter((u) => u.pathname.endsWith('/odds'));
  assert.deepEqual(odds.map((u) => u.pathname.split('/')[3]), ['tennis_atp_paris_masters', 'tennis_wta_finals', 'soccer_epl']);
  for (const u of odds) {
    assert.equal(u.searchParams.get('bookmakers'), 'pinnacle,betfair_ex_uk,paddypower,betfair_sb_uk');
    assert.equal(u.searchParams.get('regions'), null);
    assert.equal(u.searchParams.get('markets'), 'h2h');
  }
  assert.equal(events.length, 3);
});
