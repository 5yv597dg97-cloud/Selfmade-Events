import { DatabaseSync } from 'node:sqlite';

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY,
      pick_id TEXT NOT NULL,
      placed_at TEXT NOT NULL,
      event_id TEXT NOT NULL,
      sport TEXT NOT NULL,
      commence_time TEXT NOT NULL,
      home TEXT NOT NULL,
      away TEXT NOT NULL,
      market TEXT NOT NULL,
      line TEXT NOT NULL,
      outcome TEXT NOT NULL,
      point REAL,
      book TEXT NOT NULL,
      odds REAL NOT NULL CHECK (odds > 1),
      stake REAL NOT NULL CHECK (stake > 0),
      fair_prob REAL NOT NULL,
      ev REAL NOT NULL,
      close_prob REAL,
      close_at TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      pnl REAL,
      settled_at TEXT
    );
    -- Picks sent to Telegram, so each is sent once and the buttons can find it later.
    CREATE TABLE IF NOT EXISTS picks (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'placed', 'skipped'))
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const getMeta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  const setMeta = (key, value) => db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));

  return {
    db,
    addBet(pick, { odds = pick.odds, stake = pick.stake, now = new Date() } = {}) {
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO bets (pick_id, placed_at, event_id, sport, commence_time, home, away, market, line,
          outcome, point, book, odds, stake, fair_prob, ev)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(pick.id, now.toISOString(), pick.eventId, pick.sport, pick.commenceTime, pick.home, pick.away,
        pick.market, pick.line, pick.outcome, pick.point ?? null, pick.book, odds, stake,
        pick.fairProb, pick.fairProb * odds - 1);
      return Number(lastInsertRowid);
    },
    get: (id) => db.prepare('SELECT * FROM bets WHERE id = ?').get(id),
    open: () => db.prepare("SELECT * FROM bets WHERE status = 'open' ORDER BY commence_time").all(),
    all: () => db.prepare('SELECT * FROM bets ORDER BY placed_at').all(),
    setClose(id, prob, at = new Date()) {
      db.prepare('UPDATE bets SET close_prob = ?, close_at = ? WHERE id = ?').run(prob, at.toISOString(), id);
    },
    settle(id, { status, pnl }, at = new Date()) {
      db.prepare('UPDATE bets SET status = ?, pnl = ?, settled_at = ? WHERE id = ?').run(status, pnl, at.toISOString(), id);
    },
    getMeta,
    setMeta,
    pick(id) {
      const row = db.prepare('SELECT * FROM picks WHERE id = ?').get(id);
      return row && { ...JSON.parse(row.data), status: row.status };
    },
    recordPick(pick, at = new Date()) {
      db.prepare('INSERT OR IGNORE INTO picks (id, data, sent_at) VALUES (?, ?, ?)').run(pick.id, JSON.stringify(pick), at.toISOString());
    },
    /** How many picks were sent on the same UK calendar day as `now`. */
    picksSentOn(now, ukDate) {
      const since = new Date(now.getTime() - 26 * 3600e3).toISOString();
      const today = ukDate(now);
      return db.prepare('SELECT sent_at FROM picks WHERE sent_at >= ?').all(since).filter((r) => ukDate(r.sent_at) === today).length;
    },
    setPickStatus(id, status) {
      db.prepare('UPDATE picks SET status = ? WHERE id = ?').run(status, id);
    },
    /** Starting bankroll plus all settled profit and loss. */
    bankroll(start) {
      return start + (db.prepare("SELECT COALESCE(SUM(pnl), 0) AS p FROM bets WHERE status != 'open'").get().p);
    },
    /**
     * The bankroll level that pauses betting: a fixed drop from the starting
     * bankroll, or from wherever "/resume" last reset it.
     */
    stopLevel(start, pct) {
      const base = Number(getMeta('stop_base') ?? start);
      return pct > 0 ? base * (1 - pct) : -Infinity;
    },
    close: () => db.close(),
  };
}

/** Summary stats. CLV is the EV of the price you took, measured against the closing fair probability. */
export function report(bets) {
  const settled = bets.filter((b) => b.status !== 'open');
  const staked = settled.reduce((a, b) => a + b.stake, 0);
  const pnl = settled.reduce((a, b) => a + b.pnl, 0);
  const expected = settled.reduce((a, b) => a + b.stake * b.ev, 0);
  // Pushes and voids aren't wins or losses; half results count as half.
  const credit = { won: 1, 'half-won': 0.5, lost: 0, 'half-lost': 0 };
  const decided = settled.filter((b) => b.status in credit);
  const wins = decided.reduce((a, b) => a + credit[b.status], 0);
  const [winRateLow, winRateHigh] = wilson(wins, decided.length);
  const withClose = bets.filter((b) => b.close_prob != null);
  const clv = withClose.map((b) => b.odds * b.close_prob - 1);
  return {
    bets: bets.length,
    open: bets.length - settled.length,
    settled: settled.length,
    staked,
    pnl,
    roi: staked ? pnl / staked : 0,
    expectedPnl: expected,
    avgEv: bets.length ? bets.reduce((a, b) => a + b.ev, 0) / bets.length : 0,
    clvCount: clv.length,
    avgClv: clv.length ? clv.reduce((a, b) => a + b, 0) / clv.length : 0,
    beatClose: clv.length ? clv.filter((x) => x > 0).length / clv.length : 0,
    decided: decided.length,
    wins,
    winRate: decided.length ? wins / decided.length : 0,
    expectedWinRate: decided.length ? decided.reduce((a, b) => a + b.fair_prob, 0) / decided.length : 0,
    breakEvenWinRate: decided.length ? decided.reduce((a, b) => a + 1 / b.odds, 0) / decided.length : 0,
    winRateLow,
    winRateHigh,
  };
}

/** 95% Wilson score interval for a win rate. */
export function wilson(wins, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = wins / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z / (1 + (z * z) / n)) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
