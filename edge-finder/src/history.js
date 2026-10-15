// Historical results and odds from football-data.co.uk (free, no key). Each
// league-season is one CSV with the final score and several bookmakers' prices,
// including Pinnacle's early (PSH...) and closing (PSCH...) odds.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const LEAGUES = {
  E0: 'Premier League', E1: 'Championship', SP1: 'La Liga', I1: 'Serie A', D1: 'Bundesliga',
  F1: 'Ligue 1', N1: 'Eredivisie', P1: 'Primeira Liga', B1: 'Belgian Pro League', SC0: 'Scottish Premiership',
};

/** "2627" for the season running on `now` (seasons start in July). */
export function seasonCode(now, back = 0) {
  const d = new Date(now);
  const start = (d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1) - back;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
}

const num = (x) => (x === undefined || x === '' ? null : Number(x));
const triple = (row, a, b, c) => {
  const t = [num(row[a]), num(row[b]), num(row[c])];
  return t.every((x) => x > 1) ? t : null;
};

function parseDate(s) {
  const [d, m, y] = s.split('/').map(Number);
  return Date.UTC(y < 100 ? 2000 + y : y, m - 1, d, 15);
}

export function parseCsv(text, league, season) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(',');
  const out = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const row = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
    if (!row.HomeTeam || row.FTHG === '' || row.FTHG === undefined || !row.Date) continue;
    out.push({
      league, season,
      date: parseDate(row.Date),
      home: row.HomeTeam, away: row.AwayTeam,
      hg: Number(row.FTHG), ag: Number(row.FTAG),
      odds: {
        pinnacle: triple(row, 'PSH', 'PSD', 'PSA'),
        pinnacleClose: triple(row, 'PSCH', 'PSCD', 'PSCA'),
        bet365: triple(row, 'B365H', 'B365D', 'B365A'),
        williamhill: triple(row, 'WHH', 'WHD', 'WHA'),
        max: triple(row, 'MaxH', 'MaxD', 'MaxA'),
        avg: triple(row, 'AvgH', 'AvgD', 'AvgA'),
      },
    });
  }
  return out.filter((m) => Number.isFinite(m.hg) && Number.isFinite(m.ag) && Number.isFinite(m.date));
}

/**
 * Loads league-seasons, downloading any missing ones into `dir`. The current
 * season is always downloaded fresh, as it changes every week.
 */
export async function loadHistory({ leagues = Object.keys(LEAGUES), seasons, dir = 'data', now = Date.now(), fetchImpl = fetch, log = () => {} }) {
  mkdirSync(dir, { recursive: true });
  const current = seasonCode(now);
  const matches = [];
  for (const league of leagues) {
    for (const season of seasons) {
      const file = join(dir, `${league}_${season}.csv`);
      let text = null;
      if (season !== current && existsSync(file)) text = readFileSync(file, 'utf8');
      else {
        try {
          const res = await fetchImpl(`https://www.football-data.co.uk/mmz4281/${season}/${league}.csv`);
          if (res.ok) { text = await res.text(); writeFileSync(file, text); }
          else log(`  ${league} ${season}: HTTP ${res.status}`);
        } catch (err) {
          log(`  ${league} ${season}: ${err.message}`);
          if (existsSync(file)) text = readFileSync(file, 'utf8');
        }
      }
      if (text) matches.push(...parseCsv(text, league, season));
    }
  }
  return matches.sort((a, b) => a.date - b.date);
}
