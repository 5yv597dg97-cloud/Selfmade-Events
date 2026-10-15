import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitRatings, predict } from '../src/ratings.js';

// A made-up league with known strengths, played over two seasons.
function simulateLeague(seed = 1) {
  let s = seed;
  const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const poisson = (l) => { let k = 0; let p = Math.exp(-l); let c = p; const u = rand(); while (u > c) { k++; p *= l / k; c += p; } return k; };
  const teams = { Strong: [1.6, 0.6], Good: [1.2, 0.85], Mid: [1, 1], Weak: [0.75, 1.3], Poor: [0.6, 1.5], Avg: [1, 1] };
  const names = Object.keys(teams);
  const matches = [];
  let date = Date.parse('2024-08-10');
  for (let round = 0; round < 12; round++) {
    for (const h of names) for (const a of names) {
      if (h === a) continue;
      const lh = 1.35 * 1.2 * teams[h][0] * teams[a][1];
      const la = 1.35 * teams[a][0] * teams[h][1];
      matches.push({ date, home: h, away: a, hg: poisson(lh), ag: poisson(la) });
      date += 864e5 / 3;
    }
  }
  return { matches, end: date };
}

test('recovers who is strong and who is weak, and a home advantage', () => {
  const { matches, end } = simulateLeague();
  const r = fitRatings(matches, end + 864e5, { halfLifeDays: 10000 });
  assert.ok(r.att.Strong > r.att.Mid && r.att.Mid > r.att.Poor);
  assert.ok(r.def.Strong < r.def.Mid && r.def.Mid < r.def.Poor);
  assert.ok(r.home > 1.05 && r.home < 1.4, `home ${r.home}`);
  const p = predict(r, 'Strong', 'Poor');
  assert.ok(p.home > 0.7, `strong at home ${p.home}`);
  assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-9);
  const q = predict(r, 'Poor', 'Strong');
  assert.ok(q.away > q.home);
});

test('only uses matches before the date, and needs enough history', () => {
  const { matches } = simulateLeague();
  const early = fitRatings(matches, matches[3].date + 1);
  assert.equal(predict(early, 'Strong', 'Poor'), null, 'not enough games yet');
  assert.equal(predict(fitRatings(matches, matches.at(-1).date + 1), 'Strong', 'Nobody'), null);
});

import { parseCsv, seasonCode } from '../src/history.js';
import { backtest } from '../src/backtest.js';

test('reads a football-data.co.uk CSV', () => {
  const csv = '﻿Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,B365H,B365D,B365A,PSH,PSD,PSA,WHH,WHD,WHA,MaxH,MaxD,MaxA,AvgH,AvgD,AvgA,PSCH,PSCD,PSCA\r\n'
    + 'E0,16/08/2025,20:00,Liverpool,Bournemouth,4,2,H,1.3,6,9.5,1.31,6.2,10.5,1.29,5.8,9,1.33,6.4,11,1.3,6,9.6,1.28,6.5,11.2\r\n'
    + 'E0,17/08/25,14:00,Aston Villa,Newcastle,0,0,D,2.4,3.4,2.9,2.45,3.5,3.0,,,,2.5,3.6,3.1,2.4,3.4,2.9,,,\r\n,,,,,,\r\n';
  const [a, b] = parseCsv(csv, 'E0', '2526');
  assert.equal(a.home, 'Liverpool');
  assert.equal(a.hg, 4);
  assert.deepEqual(a.odds.pinnacleClose, [1.28, 6.5, 11.2]);
  assert.equal(new Date(b.date).toISOString().slice(0, 10), '2025-08-17');
  assert.equal(b.odds.williamhill, null);
  assert.equal(b.odds.pinnacleClose, null);
});

test('season codes', () => {
  assert.equal(seasonCode(Date.parse('2026-10-15')), '2627');
  assert.equal(seasonCode(Date.parse('2026-03-01')), '2526');
  assert.equal(seasonCode(Date.parse('2026-10-15'), 2), '2425');
});

test('backtest runs end to end on simulated matches with odds', () => {
  const teams = ['A', 'B', 'C', 'D'];
  const matches = [];
  let date = Date.parse('2024-08-10');
  for (let r = 0; r < 30; r++) for (const h of teams) for (const a of teams) {
    if (h === a) continue;
    const hg = (r + h.charCodeAt(0)) % 3; const ag = (r + a.charCodeAt(0)) % 2;
    matches.push({ league: 'X', season: r < 15 ? '2425' : '2526', date, home: h, away: a, hg, ag,
      odds: { pinnacle: [2.1, 3.4, 3.6], pinnacleClose: [2.05, 3.5, 3.7], bet365: [2.25, 3.3, 3.5], williamhill: null } });
    date += 864e5;
  }
  const r = backtest(matches, { testSeasons: ['2526'], minProb: 0.3 });
  assert.ok(r.accuracy.matches > 50);
  assert.ok(r.accuracy.model > 0 && r.accuracy.market > 0);
  assert.ok(r.bets.all.bets > 0);
  assert.equal(r.bets.allAgree.bets + r.bets.allDisagree.bets, r.bets.all.bets);
});

import { trixieBacktest } from '../src/backtest.js';

test('trixie backtest replays a trixie a week from the biggest favourites', () => {
  const matches = [];
  const monday = Date.parse('2025-09-01T15:00:00Z');
  for (let w = 0; w < 4; w++) {
    for (let k = 0; k < 4; k++) {
      // Favourites at 80%; in week 2 the first one loses.
      const lose = w === 2 && k === 0;
      matches.push({ season: '2526', date: monday + w * 7 * 864e5 + k * 864e5, home: `H${k}`, away: `A${k}`,
        hg: lose ? 0 : 2, ag: lose ? 1 : 0, odds: { pinnacle: [1.2 + k * 0.05, 7, 13], bet365: [1.22 + k * 0.05, 6.5, 12], max: [1.25 + k * 0.05, 7.5, 14] } });
    }
  }
  const r = trixieBacktest(matches, { seasons: ['2526'] });
  assert.equal(r.weeks, 4);
  assert.equal(r.strongest.trixies, 4);
  assert.equal(r.strongest.allThree, 3);
  assert.equal(r.strongest.returned, 4, 'two of three still pays');
  assert.equal(r.favouriteFailed, 1);
  assert.ok(r.strongestBest.profit > r.strongest.profit, 'better prices, more profit');
});
