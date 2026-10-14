import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';
import { runOnce } from '../src/run.js';

const FIXTURE = new URL('../fixtures/sample-odds.json', import.meta.url).pathname;
const CHAT = '42';

function fakeBot() {
  const bot = {
    chatId: CHAT,
    sent: [],
    queue: [],
    removed: [],
    async send(text, opts = {}) { bot.sent.push({ text, ...opts }); return { message_id: bot.sent.length }; },
    async updates() { const u = bot.queue; bot.queue = []; return u; },
    async removeButtons(id) { bot.removed.push(id); },
    async answer() {},
  };
  return bot;
}

let nextUpdate = 1;
const tap = (data, chat = CHAT) => ({ update_id: nextUpdate++, callback_query: { id: 'cq', data, message: { message_id: 7, chat: { id: Number(chat) } } } });
const say = (text, chat = CHAT) => ({ update_id: nextUpdate++, message: { message_id: 8, text, chat: { id: Number(chat) } } });

test('a full week: picks, taps, commands, settling and the stop-loss', async () => {
  const cfg = loadConfig({}, {});
  const store = openStore(':memory:');
  const bot = fakeBot();
  const at = (iso) => new Date(iso);

  // Run 1: three picks go out with buttons, sized from £100.
  let r = await runOnce({ cfg, store, bot, now: at('2026-10-14T12:00:00Z'), fixture: FIXTURE });
  assert.equal(r.sent, 3);
  const picks = bot.sent.filter((m) => m.buttons);
  assert.equal(picks.length, 3);
  assert.match(picks[2].text, /⚽ <b>Liverpool to win/);
  assert.match(picks[0].text, /Jannik Sinner to win<\/b> @ <b>1\.18/);
  assert.match(picks[0].text, /Stake <b>£2\.00/);
  const [sinner, makhachev] = picks.slice(0, 2).map((m) => m.buttons[0][0].callback_data.split(':')[1]);
  assert.match(bot.sent.at(-1).text, /Bankroll <b>£100\.00/);

  // Run 2: tap Placed on one, log the other at a different price; a stranger is ignored.
  bot.sent = [];
  bot.queue = [tap(`place:${sinner}`), say(`/placed ${makhachev} 1.29 1.5`), say('/report', '999'), tap(`place:${sinner}`, '999')];
  r = await runOnce({ cfg, store, bot, now: at('2026-10-14T12:05:00Z'), fixture: FIXTURE });
  assert.equal(r.sent, 0, 'picks are only sent once');
  const bets = store.open();
  assert.deepEqual(bets.map((b) => [b.outcome, b.odds, b.stake]), [['Jannik Sinner', 1.18, 2], ['Islam Makhachev', 1.29, 1.5]]);
  assert.equal(store.pick(sinner).status, 'placed');
  assert.ok(bot.sent.some((m) => /Logged bet 1/.test(m.text)));
  assert.ok(bets.every((b) => b.close_prob != null), 'latest sharp price recorded for CLV');
  assert.equal(store.getMeta('telegram_offset'), String(nextUpdate));

  // Run 3: Sinner's match finished; Makhachev's has no score yet.
  const dir = mkdtempSync(join(tmpdir(), 'edge-'));
  const scores = join(dir, 'scores.json');
  writeFileSync(scores, JSON.stringify([{ id: 'evt_sinner', completed: true, scores: [{ name: 'Jannik Sinner', score: '2' }, { name: 'Hugo Gaston', score: '1' }] }]));
  bot.sent = [];
  r = await runOnce({ cfg, store, bot, now: at('2026-10-15T18:00:00Z'), fixture: FIXTURE, scoresFile: scores });
  assert.equal(r.settled, 1);
  assert.ok(bot.sent.some((m) => /✅ Bet 1 won/.test(m.text)));
  assert.equal(r.bankroll, 100.36);

  // A big loss takes the bankroll under £70: betting pauses until /resume.
  bot.queue = [say(`/placed ${sinner} 1.18 40`), say('/result 2 lost'), say('/result 3 lost')];
  bot.sent = [];
  r = await runOnce({ cfg, store, bot, now: at('2026-10-14T12:10:00Z'), fixture: FIXTURE });
  assert.ok(bot.sent.some((m) => /already logged/.test(m.text)), 'a placed pick can\'t be logged twice');
  bot.queue = [say('/result 2 lost')];
  bot.sent = [];
  r = await runOnce({ cfg, store, bot, now: at('2026-10-14T12:10:00Z'), fixture: FIXTURE });
  assert.ok(bot.sent.some((m) => /already settled/.test(m.text)));

  store.settle(1, { status: 'lost', pnl: -32 }); // pretend a heavy loss
  bot.sent = [];
  r = await runOnce({ cfg, store, bot, now: at('2026-10-14T12:10:00Z'), fixture: FIXTURE });
  assert.equal(r.paused, true, JSON.stringify({ r, bets: store.all().map((b) => [b.id, b.status, b.pnl]) }));
  assert.equal(r.sent, 0);
  assert.match(bot.sent.at(-1).text, /Paused/);

  bot.queue = [say('/resume')];
  bot.sent = [];
  r = await runOnce({ cfg, store, bot, now: at('2026-10-14T12:10:00Z'), fixture: FIXTURE });
  assert.equal(r.paused, false);
  assert.ok(bot.sent.some((m) => /New stop-loss: £46\.55/.test(m.text)));
  store.close();
});

test('unknown commands get the help text', async () => {
  const store = openStore(':memory:');
  const bot = fakeBot();
  bot.queue = [say('hello')];
  await runOnce({ cfg: loadConfig({}, {}), store, bot, now: new Date('2026-10-14T12:00:00Z'), fixture: FIXTURE });
  assert.match(bot.sent[0].text, /Commands/);
  store.close();
});
