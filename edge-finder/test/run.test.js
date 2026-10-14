import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';
import { runOnce, linkChat } from '../src/run.js';

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
  const picks = bot.sent.filter((m) => m.buttons && !/Fun double/.test(m.text));
  assert.equal(picks.length, 3);
  assert.match(picks[2].text, /⚽ <b>Liverpool to win/);
  assert.match(picks[0].text, /Jannik Sinner to win<\/b> @ <b>1\.18/);
  assert.match(picks[0].text, /Stake <b>£2\.00/);
  assert.match(picks[0].text, /Still worth it at <b>1\.16<\/b> or better/);
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

test('no more than 5 picks a day; the rest wait', async () => {
  const cfg = loadConfig({}, { 'max-picks-per-day': 2 });
  const store = openStore(':memory:');
  const bot = fakeBot();
  let r = await runOnce({ cfg, store, bot, now: new Date('2026-10-14T12:00:00Z'), fixture: FIXTURE });
  assert.equal(r.sent, 2);
  assert.match(bot.sent.at(-1).text, /1 more pick held back by your 2-a-day limit/);
  r = await runOnce({ cfg, store, bot, now: new Date('2026-10-14T12:05:00Z'), fixture: FIXTURE });
  assert.equal(r.sent, 0, 'still the same UK day');
  // Just after midnight UK time (23:05 UTC in BST) it's a new day.
  r = await runOnce({ cfg: { ...cfg, maxStaleMinutes: 1e6 }, store, bot, now: new Date('2026-10-14T23:05:00Z'), fixture: FIXTURE });
  assert.equal(r.sent, 1);
  assert.equal(loadConfig({}, {}).maxPicksPerDay, 5);
  store.close();
});

test('warns once about a bookmaker that never appears in the data', async () => {
  const cfg = loadConfig({}, { books: 'paddypower,betfred' });
  const store = openStore(':memory:');
  const bot = fakeBot();
  await runOnce({ cfg, store, bot, now: new Date('2026-10-14T12:00:00Z'), fixture: FIXTURE });
  assert.match(bot.sent.at(-1).text, /No prices found from: betfred/);
  await runOnce({ cfg, store, bot, now: new Date('2026-10-14T12:05:00Z'), fixture: FIXTURE });
  assert.doesNotMatch(bot.sent.at(-1).text, /betfred/);
  store.close();
});

test('links the first private chat when no chat ID is set', async () => {
  const store = openStore(':memory:');
  const api = { updates: async () => [{ update_id: 1, message: { text: 'hi', chat: { id: 1234, type: 'private' } } }] };
  assert.deepEqual(await linkChat(store, api), { chatId: '1234', isNew: true });
  const other = { updates: async () => [{ update_id: 2, message: { text: 'hi', chat: { id: 999, type: 'private' } } }] };
  assert.deepEqual(await linkChat(store, other), { chatId: '1234', isNew: false }, 'a stranger can\'t take over later');
  await assert.rejects(linkChat(openStore(':memory:'), { updates: async () => [] }), /send it any message/);
  store.close();
});

test('fun doubles: found, sent, placed, settled, and kept out of the win rate', async () => {
  const cfg = loadConfig({}, {});
  const store = openStore(':memory:');
  const bot = fakeBot();
  let r = await runOnce({ cfg, store, bot, now: new Date('2026-10-14T12:00:00Z'), fixture: FIXTURE });
  assert.equal(r.doublesSent, 1);
  const msg = bot.sent.find((m) => /Fun double/.test(m.text));
  assert.match(msg.text, /@ <b>66\.3<\/b> \(65\/1\) with Paddy Power/);
  assert.match(msg.text, /Arthur Fils to win @ 5\.1/);
  assert.match(msg.text, /Wolverhampton Wanderers to win @ 13/);
  assert.match(msg.text, /Stake <b>£0\.20<\/b> to win £13\.06/);
  const id = msg.buttons[0][0].callback_data.split(':')[1];

  // Placed by button; not sent again on the next run.
  bot.queue = [tap(`place:${id}`)];
  bot.sent = [];
  r = await runOnce({ cfg, store, bot, now: new Date('2026-10-14T12:05:00Z'), fixture: FIXTURE });
  assert.equal(r.doublesSent, 0);
  assert.ok(bot.sent.some((m) => /Logged double D1 @ 66\.3, £0\.20/.test(m.text)));

  // Fils wins Thursday; the double stays open until Wolves play.
  const dir = mkdtempSync(join(tmpdir(), 'edge-'));
  const scores = join(dir, 'scores.json');
  const fils = { id: 'evt_alc_fil', completed: true, scores: [{ name: 'Carlos Alcaraz', score: '1' }, { name: 'Arthur Fils', score: '2' }] };
  writeFileSync(scores, JSON.stringify([fils]));
  r = await runOnce({ cfg, store, bot, now: new Date('2026-10-15T22:00:00Z'), fixture: FIXTURE, scoresFile: scores });
  assert.equal(store.getDouble(1).legs[0].result, 'won');
  assert.equal(store.getDouble(1).status, 'open');

  // Wolves win at the Etihad: the double lands.
  writeFileSync(scores, JSON.stringify([fils, { id: 'evt_mci_wol', completed: true, scores: [{ name: 'Manchester City', score: '0' }, { name: 'Wolverhampton Wanderers', score: '1' }] }]));
  bot.sent = [];
  r = await runOnce({ cfg, store, bot, now: new Date('2026-10-17T20:00:00Z'), fixture: FIXTURE, scoresFile: scores });
  assert.ok(bot.sent.some((m) => /🎉 Double D1 won.*£13\.06/.test(m.text)));
  assert.equal(store.bankroll(100), 113.06);
  assert.match(bot.sent.at(-1).text, /Fun doubles: 1 placed, 1 won, 0 lost · £13\.06/);
  assert.doesNotMatch(bot.sent.at(-1).text, /Won \d+ of/, 'no singles win rate yet');
  store.close();
});

test('at most 5 doubles a week, and /result settles one by hand', async () => {
  const cfg = loadConfig({}, { 'doubles-per-week': 0 });
  const store = openStore(':memory:');
  const bot = fakeBot();
  const r = await runOnce({ cfg, store, bot, now: new Date('2026-10-14T12:00:00Z'), fixture: FIXTURE });
  assert.equal(r.doublesSent, 0);
  store.close();

  const s2 = openStore(':memory:');
  const b2 = fakeBot();
  await runOnce({ cfg: loadConfig({}, {}), store: s2, bot: b2, now: new Date('2026-10-14T12:00:00Z'), fixture: FIXTURE });
  const id = b2.sent.find((m) => /Fun double/.test(m.text)).buttons[0][0].callback_data.split(':')[1];
  b2.queue = [tap(`place:${id}`), say('/result D1 lost'), say('/bets')];
  b2.sent = [];
  await runOnce({ cfg: loadConfig({}, {}), store: s2, bot: b2, now: new Date('2026-10-14T12:05:00Z'), fixture: FIXTURE });
  assert.ok(b2.sent.some((m) => /Double D1: lost -£0\.20/.test(m.text)));
  assert.equal(s2.bankroll(100), 99.8);
  s2.close();
});
