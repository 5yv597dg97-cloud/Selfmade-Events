// Matching team names between The Odds API ("Wolverhampton Wanderers") and
// football-data.co.uk ("Wolves"). Known differences are listed; otherwise names
// are compared after stripping accents, punctuation and club-type words.
const ALIASES = {
  // English
  'manchester city': 'man city', 'manchester united': 'man united', 'nottingham forest': "nott'm forest",
  'wolverhampton wanderers': 'wolves', 'newcastle united': 'newcastle', 'tottenham hotspur': 'tottenham',
  'west ham united': 'west ham', 'brighton and hove albion': 'brighton', 'leicester city': 'leicester',
  'leeds united': 'leeds', 'ipswich town': 'ipswich', 'luton town': 'luton', 'sheffield united': 'sheffield united',
  'sheffield wednesday': 'sheffield weds', 'west bromwich albion': 'west brom', 'queens park rangers': 'qpr',
  'afc bournemouth': 'bournemouth', 'bournemouth': 'bournemouth', 'norwich city': 'norwich', 'stoke city': 'stoke',
  'swansea city': 'swansea', 'cardiff city': 'cardiff', 'hull city': 'hull', 'coventry city': 'coventry',
  'birmingham city': 'birmingham', 'derby county': 'derby', 'preston north end': 'preston', 'oxford united': 'oxford',
  'plymouth argyle': 'plymouth', 'blackburn rovers': 'blackburn', 'bristol city': 'bristol city',
  // Spanish
  'atletico madrid': 'ath madrid', 'athletic bilbao': 'ath bilbao', 'real betis': 'betis', 'celta vigo': 'celta',
  'real sociedad': 'sociedad', 'rayo vallecano': 'vallecano', 'espanyol': 'espanol', 'deportivo alaves': 'alaves',
  'real valladolid': 'valladolid', 'cd leganes': 'leganes', 'ca osasuna': 'osasuna', 'real oviedo': 'oviedo',
  // Italian
  'inter milan': 'inter', 'ac milan': 'milan', 'as roma': 'roma', 'hellas verona': 'verona', 'ss lazio': 'lazio',
  // German
  'bayern munich': 'bayern munich', 'borussia dortmund': 'dortmund', 'bayer leverkusen': 'leverkusen',
  'borussia monchengladbach': "m'gladbach", 'eintracht frankfurt': 'ein frankfurt', 'vfb stuttgart': 'stuttgart',
  'tsg hoffenheim': 'hoffenheim', 'sc freiburg': 'freiburg', 'vfl wolfsburg': 'wolfsburg', 'fc koln': 'fc koln',
  '1 fc koln': 'fc koln', 'mainz 05': 'mainz', 'fsv mainz 05': 'mainz', 'fc st pauli': 'st pauli',
  'fc augsburg': 'augsburg', 'werder bremen': 'werder bremen', 'union berlin': 'union berlin', '1 fc union berlin': 'union berlin',
  '1 fc heidenheim': 'heidenheim', 'hamburger sv': 'hamburg', 'rb leipzig': 'rb leipzig',
  // French
  'paris saint germain': 'paris sg', 'olympique lyonnais': 'lyon', 'olympique marseille': 'marseille',
  'as monaco': 'monaco', 'stade rennais': 'rennes', 'rc lens': 'lens', 'losc lille': 'lille', 'ogc nice': 'nice',
  'stade brestois': 'brest', 'rc strasbourg': 'strasbourg', 'saint etienne': 'st etienne', 'paris fc': 'paris fc',
  // Dutch, Portuguese, Belgian, Scottish
  'psv eindhoven': 'psv eindhoven', 'feyenoord': 'feyenoord', 'az alkmaar': 'az alkmaar', 'ajax': 'ajax',
  'nec nijmegen': 'nijmegen', 'fc twente': 'twente', 'fc utrecht': 'utrecht', 'sc heerenveen': 'heerenveen',
  'sporting lisbon': 'sp lisbon', 'sporting cp': 'sp lisbon', 'fc porto': 'porto', 'sc braga': 'sp braga', 'braga': 'sp braga',
  'vitoria guimaraes': 'guimaraes', 'union saint gilloise': 'st gilloise', 'club brugge': 'club brugge',
  'rangers': 'rangers', 'celtic': 'celtic', 'heart of midlothian': 'hearts', 'hibernian': 'hibernian',
};

const STRIP = /\b(fc|afc|cf|sc|ac|as|ss|cd|ca|rc|sv|vfl|vfb|tsg|fk|nk|sk|jk|pfc|club|de|the)\b/g;

export function normalise(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Finds the football-data name for an Odds API team among `known` names, or null. */
export function matchTeam(name, known) {
  const n = normalise(name);
  const byNorm = new Map(known.map((k) => [normalise(k), k]));
  const alias = ALIASES[n];
  if (alias && byNorm.has(alias)) return byNorm.get(alias);
  if (byNorm.has(n)) return byNorm.get(n);
  const core = (s) => s.replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
  const c = core(n);
  const hits = known.filter((k) => {
    const kc = core(normalise(k));
    return kc && c && (kc === c || (kc.length >= 4 && c.startsWith(kc)) || (c.length >= 4 && kc.startsWith(c)));
  });
  return hits.length === 1 ? hits[0] : null;
}
