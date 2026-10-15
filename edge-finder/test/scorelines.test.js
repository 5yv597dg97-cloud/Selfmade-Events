import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { scoreGrid, summarise, fitGoals, sharpView, likelyScorelines, findScorelineDoubles } from '../src/scorelines.js';

const events = JSON.parse(readFileSync(new URL('../fixtures/sample-odds.json', import.meta.url)));
const NOW = Date.parse('2026-10-14T12:00:00Z');
const cfg = loadConfig({}, {});
const close = (a, b, tol) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

test('the scoreline grid is a proper distribution with extra low-score draws', () => {
  const g = scoreGrid(1.4, 1.1);
  close(g.flat().reduce((a, b) => a + b, 0), 1, 1e-12);
  const plain = scoreGrid(1.4, 1.1, 0);
  assert.ok(g[0][0] > plain[0][0] && g[1][1] > plain[1][1], 'Dixon-Coles adds 0-0 and 1-1');
  assert.ok(g[1][0] < plain[1][0]);
});

test('fitting recovers the expected goals behind a set of prices', () => {
  for (const [lh, la, line] of [[1.9, 0.8, 2.5], [1.2, 1.3, 2.5], [2.6, 0.6, 3]]) {
    const s = summarise(scoreGrid(lh, la), line);
    const fit = fitGoals({ home: s.home, away: s.away, over: s.over / (1 - s.push), line });
    close(fit.lh, lh, 0.011);
    close(fit.la, la, 0.011);
  }
});

test('reads match result and the total goals line nearest 2.5 from the sharp books', () => {
  const liv = events.find((e) => e.id === 'evt_liv_bur');
  assert.equal(sharpView(liv, cfg, NOW), null, 'a quarter line (2.75) is skipped');
  const city = sharpView(events.find((e) => e.id === 'evt_mci_wol'), cfg, NOW);
  assert.equal(city.line, 3);
  assert.ok(city.home > 0.7 && city.over > 0.45 && city.over < 0.55);
  assert.equal(sharpView(events.find((e) => e.id === 'evt_sinner'), cfg, NOW), null, 'not football');
});

test('likeliest scorelines for a strong home side', () => {
  const m = likelyScorelines(events.find((e) => e.id === 'evt_mci_wol'), cfg, NOW);
  assert.equal(m.top.length, 4);
  assert.ok(m.xg[0] > 2 * m.xg[1]);
  assert.ok(m.top.every((s) => Number(s.score[0]) >= Number(s.score[2])), 'all home wins or draws');
  assert.ok(m.top[0].p >= m.top[3].p);
});

test('scoreline doubles land near 99/1, with each leg priced above fair', () => {
  const [d] = findScorelineDoubles(events, cfg, NOW);
  assert.equal(d.type, 'scoreline');
  assert.deepEqual(d.legs.map((l) => `${l.home} ${l.outcome}`), ['Manchester City 1-0', 'Arsenal 1-0']);
  assert.ok(d.odds >= 51 && d.odds <= 151);
  for (const l of d.legs) assert.ok(l.odds * l.fairProb >= 1.05 - 1e-9 && l.odds * l.fairProb < 1.05 + 0.01);
  assert.equal(new Set(findScorelineDoubles(events, cfg, NOW).flatMap((x) => x.legs.map((l) => l.eventId))).size,
    findScorelineDoubles(events, cfg, NOW).length * 2, 'no match used twice');
});
