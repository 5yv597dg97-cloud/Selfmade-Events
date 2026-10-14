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
  `);

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
    close: () => db.close(),
  };
}

/** Summary stats. CLV is the EV of the price you took, measured against the closing fair probability. */
export function report(bets) {
  const settled = bets.filter((b) => b.status !== 'open');
  const staked = settled.reduce((a, b) => a + b.stake, 0);
  const pnl = settled.reduce((a, b) => a + b.pnl, 0);
  const expected = settled.reduce((a, b) => a + b.stake * b.ev, 0);
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
  };
}
