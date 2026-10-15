import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchTeam } from '../src/teams.js';

const known = ['Man City', 'Man United', 'Wolves', "Nott'm Forest", 'Brighton', 'Bournemouth', 'Arsenal', 'Sunderland',
  'Newcastle', 'Paris SG', 'Lyon', 'Ath Madrid', 'Real Madrid', 'Dortmund', 'Leverkusen', "M'gladbach", 'Inter', 'Milan', 'Bayern Munich'];

test('matches Odds API names to football-data names', () => {
  const cases = {
    'Manchester City': 'Man City', 'Manchester United': 'Man United', 'Wolverhampton Wanderers': 'Wolves',
    'Nottingham Forest': "Nott'm Forest", 'Brighton and Hove Albion': 'Brighton', 'AFC Bournemouth': 'Bournemouth',
    Arsenal: 'Arsenal', Sunderland: 'Sunderland', 'Newcastle United': 'Newcastle', 'Paris Saint Germain': 'Paris SG',
    'Atlético Madrid': 'Ath Madrid', 'Real Madrid': 'Real Madrid', 'Borussia Dortmund': 'Dortmund',
    'Bayer Leverkusen': 'Leverkusen', 'Borussia Mönchengladbach': "M'gladbach", 'Inter Milan': 'Inter', 'AC Milan': 'Milan',
    'Bayern Munich': 'Bayern Munich',
  };
  for (const [api, fd] of Object.entries(cases)) assert.equal(matchTeam(api, known), fd, api);
});

test('no match rather than a wrong match', () => {
  assert.equal(matchTeam('Torreense', known), null);
  assert.equal(matchTeam('Manchester', known), null, 'ambiguous');
});
