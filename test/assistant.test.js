// The owner's Telegram business assistant, with stand-ins for Telegram and Claude.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import Anthropic from '@anthropic-ai/sdk';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { mockPayments } from '../src/payments.js';
import { createAssistant, formatReport } from '../src/assistant/index.js';
import { createBrain, MODEL } from '../src/assistant/brain.js';
import { createBusinessData } from '../src/assistant/data.js';
import { createTelegram, chunks } from '../src/assistant/telegram.js';

const FEES = { bookingFeePercent: 5, bookingFeeFixedPence: 30, commissionPercent: 0, featuredDayPence: 200 };
const OWNER = '1001';

function fakeTelegram() {
  return {
    sent: [],
    typingCount: 0,
    async send(chatId, text) { this.sent.push({ chatId: String(chatId), text }); },
    async typing() { this.typingCount++; },
    async updates() { return []; },
  };
}

/** Stands in for the Anthropic client; each scripted step returns one API response. */
function fakeClaude(steps = []) {
  const calls = [];
  return {
    calls,
    steps,
    beta: {
      messages: {
        async create(params) {
          calls.push(structuredClone(params));
          const step = steps.shift();
          if (!step) throw new Error('No scripted response left');
          return typeof step === 'function' ? step(params) : step;
        },
      },
    },
  };
}

const reply = (content, stop_reason = 'end_turn') => ({
  id: 'msg', type: 'message', role: 'assistant', model: MODEL, content, stop_reason, stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});
const text = (t) => reply([{ type: 'text', text: t }]);
const toolCall = (name, input, id = 'toolu_1') => reply([
  { type: 'thinking', thinking: '', signature: 'sig' },
  { type: 'tool_use', id, name, input },
], 'tool_use');

let db;
let telegram;
let claude;
let assistant;
let app;
let clock;
let refundOk;
let silent;

function build({ owner = OWNER, withClaude = true, steps = [] } = {}) {
  claude = withClaude ? fakeClaude(steps) : null;
  telegram = fakeTelegram();
  silent = { errors: [], error(...a) { this.errors.push(a); }, warn() {} };
  const payments = {
    ...mockPayments,
    async startCheckout() { return { status: 'paid', reference: `pi_${Math.random().toString(36).slice(2, 8)}` }; },
    async refund() { return refundOk ? { ok: true } : { ok: false, error: 'card expired' }; },
    parseWebhook(raw, signature) {
      if (signature !== 'valid') throw new Error('bad signature');
      return JSON.parse(raw.toString());
    },
  };
  assistant = createAssistant({
    db, fees: FEES, payments, telegram, client: claude, ownerChatId: owner,
    siteUrl: 'https://tickets.example', now: () => clock, log: silent,
  });
  app = createApp({ db, payments, fees: FEES, assistant, sessionSecret: 'test' });
}

beforeEach(() => {
  db = openDb();
  clock = new Date();
  refundOk = true;
  build();
});

const message = (body, chatId = OWNER) => ({ update_id: 1, message: { message_id: 1, chat: { id: Number(chatId) }, text: body } });
const lastSent = () => telegram.sent.at(-1)?.text;

async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('timed out waiting');
}

async function csrfFrom(agent, path) {
  const res = await agent.get(path);
  const m = res.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(m, `no csrf token on ${path} (status ${res.status})`);
  return m[1];
}

async function signUp(role, email = `${role}@test.com`) {
  const agent = request.agent(app);
  const _csrf = await csrfFrom(agent, '/register');
  await agent.post('/register').type('form').send({ _csrf, name: role === 'host' ? 'Hana Host' : 'Bo Buyer', email, password: 'password123', role });
  return agent;
}

function futureLocal(days = 10) {
  const d = new Date(Date.now() + days * 864e5);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T19:00`;
}

async function createEvent(host, { title = 'Jazz Night', description = 'Live jazz.' } = {}) {
  const _csrf = await csrfFrom(host, '/host/events/new');
  await host.post('/host/events').type('form').send({
    _csrf, title, description, venue: 'Hall', starts_at: futureLocal(), publish: '1',
    'types[0][name]': 'GA', 'types[0][price]': '20', 'types[0][capacity]': '50',
  });
  const event = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
  const type = db.prepare('SELECT * FROM ticket_types WHERE event_id = ?').get(event.id);
  return { event, type };
}

async function buy(agent, event, type, qty) {
  const _csrf = await csrfFrom(agent, `/events/${event.id}`);
  await agent.post(`/events/${event.id}/checkout`).type('form').send({ _csrf, [`qty_${type.id}`]: String(qty) });
}

test('only the owner gets answers; before setup it only tells people their chat ID', async () => {
  await assistant.handleUpdate(message('How are sales?', '999'));
  assert.equal(telegram.sent.length, 0);
  assert.equal(claude.calls.length, 0);

  build({ owner: null });
  await assistant.handleUpdate(message('hi', '4242'));
  assert.equal(telegram.sent.length, 1);
  assert.equal(telegram.sent[0].chatId, '4242');
  assert.match(lastSent(), /chat's ID is 4242.*TELEGRAM_ASSISTANT_CHAT_ID/s);
  assert.equal(claude.calls.length, 0);
});

test('/help explains what the assistant does', async () => {
  await assistant.handleUpdate(message('/help'));
  assert.match(lastSent(), /Ask me anything about the business/);
  assert.match(lastSent(), /\/report/);
});

test('a question is answered from live figures through a read-only tool', async () => {
  const host = await signUp('host');
  const { event, type } = await createEvent(host);
  const buyer = await signUp('client');
  await buy(buyer, event, type, 2); // 2 x £20 + 2 x £1.30 booking fee
  claude.calls.length = 0; // ignore the background check of the new event

  claude.steps.push(toolCall('get_business_summary', {}), text('This week: £2.60 income from 2 tickets.'));
  await assistant.handleUpdate(message('How did we do this week?'));

  assert.equal(lastSent(), 'This week: £2.60 income from 2 tickets.');
  assert.equal(telegram.sent[0].chatId, OWNER);
  assert.ok(telegram.typingCount > 0);

  const [first, second] = claude.calls;
  assert.equal(first.model, 'claude-opus-5-5');
  assert.deepEqual(first.betas, ['server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01']);
  assert.equal(first.fallbacks, 'default');
  assert.deepEqual(first.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  assert.deepEqual(first.output_config, { effort: 'medium' });
  assert.ok(first.tools.some((t) => t.name === 'list_events'));
  assert.match(first.messages[0].content, /^\[\w{3}, \d+ \w{3} \d{4}, .* UK time\] How did we do this week\?$/);

  // The tool ran against the real database, and its result went back to Claude.
  const toolResult = second.messages.at(-1).content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 'toolu_1');
  const figures = JSON.parse(toolResult.content);
  assert.equal(figures.income_gbp, 2.6);
  assert.equal(figures.tickets_sold, 2);
  assert.equal(figures.ticket_sales_gbp, 40);
  // The assistant turn with the tool call is passed back unchanged, thinking block included.
  assert.deepEqual(second.messages[1].content, toolCall('get_business_summary', {}).content);
  assert.equal(second.system, first.system);
});

test('follow-up questions continue the conversation without rewriting it; /new starts afresh', async () => {
  claude.steps.push(text('£0 so far.'), text('Still £0 last month.'));
  await assistant.handleUpdate(message('Income this month?'));
  await assistant.handleUpdate(message('And last month?'));
  const [first, second] = claude.calls;
  assert.equal(second.messages.length, 3);
  assert.deepEqual(second.messages.slice(0, 2), [...first.messages, { role: 'assistant', content: text('£0 so far.').content }]);

  claude.steps.push(text('OK'));
  await assistant.handleUpdate(message('/new'));
  assert.match(lastSent(), /fresh conversation/);
  await assistant.handleUpdate(message('Hello'));
  assert.equal(claude.calls.at(-1).messages.length, 1);

  // A long gap also starts a new conversation.
  claude.steps.push(text('Hi again'));
  clock = new Date(clock.getTime() + 31 * 60 * 1000);
  await assistant.handleUpdate(message('Hello again'));
  assert.equal(claude.calls.at(-1).messages.length, 1);
});

test('bad tool input is reported back to Claude as an error, not thrown', async () => {
  claude.steps.push(toolCall('list_events', { status: 'everything' }), text('Here are your events.'));
  await assistant.handleUpdate(message('List everything'));
  const result = claude.calls[1].messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /status must be one of/);
  assert.equal(lastSent(), 'Here are your events.');
});

test('refusals and API errors get a short apology and reset the conversation', async () => {
  claude.steps.push(reply([], 'refusal'));
  await assistant.handleUpdate(message('Something odd'));
  assert.match(lastSent(), /can't help with that one/);

  claude.steps.push(() => { throw new Error('overloaded'); });
  await assistant.handleUpdate(message('Sales?'));
  assert.match(lastSent(), /something went wrong/);
  assert.equal(silent.errors.length, 1);

  claude.steps.push(text('Fine now.'));
  await assistant.handleUpdate(message('Sales?'));
  assert.equal(claude.calls.at(-1).messages.length, 1);
});

test('without an API key, questions explain how to switch answers on; reports still work', async () => {
  build({ withClaude: false });
  await assistant.handleUpdate(message('How are we doing?'));
  assert.match(lastSent(), /ANTHROPIC_API_KEY/);
  await assistant.handleUpdate(message('/report'));
  assert.match(lastSent(), /Weekly report/);
  assert.doesNotMatch(lastSent(), /Suggestions/);
});

test('the weekly report goes out once, from Monday 8am UK time', async () => {
  // Wednesday: the first check only records where to start from.
  clock = new Date('2026-10-14T12:00:00Z');
  await assistant.checkWeeklyReport();
  assert.equal(telegram.sent.length, 0);

  clock = new Date('2026-10-19T06:59:00Z'); // Monday 7:59am BST
  await assistant.checkWeeklyReport();
  assert.equal(telegram.sent.length, 0);

  claude.steps.push(text('• Ask Hana to feature Jazz Night.'));
  clock = new Date('2026-10-19T07:05:00Z'); // Monday 8:05am BST
  await assistant.checkWeeklyReport();
  assert.equal(telegram.sent.length, 1);
  assert.match(lastSent(), /Weekly report: Mon 12 Oct to Sun 18 Oct/);
  assert.match(lastSent(), /Suggestions\n• Ask Hana to feature Jazz Night\./);
  const reportCall = claude.calls.at(-1);
  assert.equal(reportCall.tools, undefined);
  assert.equal(JSON.parse(reportCall.messages[0].content).week.start_date, '2026-10-12');
  assert.doesNotMatch(reportCall.messages[0].content, /email/);

  clock = new Date('2026-10-19T15:00:00Z');
  await assistant.checkWeeklyReport();
  assert.equal(telegram.sent.length, 1, 'only once a week');

  // If the server was down on Monday, the report goes out when it's back.
  clock = new Date('2026-10-27T10:00:00Z'); // Tuesday, after the clocks went back
  claude.steps.push(text('• Keep going.'));
  await assistant.checkWeeklyReport();
  assert.equal(telegram.sent.length, 2);
  assert.match(lastSent(), /Mon 19 Oct to Sun 25 Oct/);
});

test('the report shows figures and what needs attention', async () => {
  const host = await signUp('host');
  const { event, type } = await createEvent(host);
  const buyer = await signUp('client');
  await buy(buyer, event, type, 1);
  const data = createBusinessData({ db, fees: FEES, payments: mockPayments });
  const digest = data.weeklyDigest(new Date(Date.now() + 7 * 864e5)); // next week, so these sales are "last week"
  const report = formatReport(digest, null);
  assert.match(report, /Income: £1\.30/);
  assert.match(report, /Ticket sales: £20\.00 from 1 ticket \(1 order\)/);
  assert.match(report, /Top events\n• Jazz Night \(Hana Host\)/);
  assert.match(report, /Selling slowly: "Jazz Night", 1\/50 sold/);
  assert.match(report, /demo mode/);
});

test('a risky-looking new event is flagged to the owner; a normal one is not', async () => {
  const host = await signUp('host');
  claude.steps.push(text(JSON.stringify({ verdict: 'ok', reasons: [] })));
  await createEvent(host, { title: 'Quiz Night' });
  await waitFor(() => claude.calls.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(telegram.sent.length, 0);

  claude.steps.push(text(JSON.stringify({ verdict: 'review', reasons: ['Asks buyers to pay by bank transfer'] })));
  const { event } = await createEvent(host, { title: 'Beyonce live £5', description: 'Pay by bank transfer, WhatsApp me.' });
  await waitFor(() => telegram.sent.length === 1);
  assert.match(lastSent(), /may need a look: "Beyonce live £5" by Hana Host \(host@test\.com\)/);
  assert.match(lastSent(), /• Asks buyers to pay by bank transfer/);
  assert.match(lastSent(), new RegExp(`https://tickets\\.example/events/${event.id}`));

  const screen = claude.calls[1];
  assert.equal(screen.output_config.effort, 'low');
  assert.equal(screen.output_config.format.type, 'json_schema');
  assert.match(screen.messages[0].content, /^<listing>[\s\S]*bank transfer[\s\S]*<\/listing>$/);
  assert.doesNotMatch(screen.messages[0].content, /host@test\.com/, 'no contact details sent for screening');
});

test('payment disputes from Stripe are reported with the order they belong to', async () => {
  const host = await signUp('host');
  const { event, type } = await createEvent(host);
  const buyer = await signUp('client');
  await buy(buyer, event, type, 1);
  const order = db.prepare('SELECT * FROM orders').get();

  const post = (type, object) => request(app).post('/stripe/webhook')
    .set('Content-Type', 'application/json').set('Stripe-Signature', 'valid')
    .send(JSON.stringify({ id: 'evt_d', type, data: { object } }));
  const dispute = { id: 'dp_1', amount: 2130, currency: 'gbp', reason: 'product_not_received', payment_intent: order.payment_reference, evidence_details: { due_by: 1793750400 } };

  const res = await post('charge.dispute.created', dispute);
  assert.equal(res.status, 200);
  await waitFor(() => telegram.sent.some((m) => /disputed/.test(m.text)));
  assert.match(lastSent(), new RegExp(`£21\\.30 on order #${order.id} for "Jazz Night" \\(host: Hana Host\\)\\. Reason: product not received`));
  assert.match(lastSent(), /Respond in your Stripe dashboard.* by /);

  // A repeat delivery of the same Stripe event doesn't alert twice.
  await post('charge.dispute.created', dispute);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(telegram.sent.filter((m) => /disputed/.test(m.text)).length, 1);

  await request(app).post('/stripe/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', 'valid')
    .send(JSON.stringify({ id: 'evt_closed', type: 'charge.dispute.closed', data: { object: { ...dispute, status: 'won' } } }));
  await waitFor(() => /closed: you won it/.test(lastSent()));
});

test('failed refunds are reported to the owner', async () => {
  const host = await signUp('host');
  const { event, type } = await createEvent(host);
  const buyer = await signUp('client');
  await buy(buyer, event, type, 1);
  await waitFor(() => claude.calls.length >= 1); // the event check, which has no scripted answer
  refundOk = false;
  const _csrf = await csrfFrom(host, '/host');
  await host.post(`/host/events/${event.id}/cancel`).type('form').send({ _csrf });
  await waitFor(() => telegram.sent.some((m) => /refund\(s\) failed/.test(m.text)));
  assert.match(lastSent(), /Hana Host cancelled "Jazz Night", but 1 refund\(s\) failed/);
});

test('the polling loop hands each message to the assistant and moves past it', async () => {
  const offsets = [];
  telegram.updates = async (offset) => {
    offsets.push(offset);
    if (offsets.length === 1) return [{ ...message('/help'), update_id: 41 }];
    assistant.stop();
    return [];
  };
  assistant.start();
  await waitFor(() => offsets.length === 2);
  assert.deepEqual(offsets, [undefined, 42]);
  assert.match(telegram.sent[0].text, /Ask me anything/);
});

test('Telegram client: long messages are split, and API errors are raised', async () => {
  const parts = chunks(`${'a'.repeat(3000)}\n${'b'.repeat(3000)}`, 4000);
  assert.deepEqual(parts.map((p) => p.length), [3000, 3000]);
  assert.deepEqual(chunks('x'.repeat(9000), 4000).map((p) => p.length), [4000, 4000, 1000]);

  const requests = [];
  const tg = createTelegram({
    token: 'T0K',
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return { json: async () => (requests.length === 1 ? { ok: true, result: {} } : { ok: false, description: 'chat not found' }) };
    },
  });
  await tg.send(1001, 'Hello');
  assert.equal(requests[0].url, 'https://api.telegram.org/botT0K/sendMessage');
  assert.equal(requests[0].body.chat_id, 1001);
  assert.equal(requests[0].body.text, 'Hello');
  assert.equal(requests[0].body.parse_mode, undefined);
  await assert.rejects(tg.send(1001, 'Again'), /chat not found/);
});

test('requests reach the Claude API with the right beta headers and body', async () => {
  const seen = [];
  const client = new Anthropic({
    apiKey: 'sk-ant-test',
    maxRetries: 0,
    fetch: async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return new Response(JSON.stringify(text('Hi from Claude')), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const data = createBusinessData({ db, fees: FEES, payments: mockPayments });
  const brain = createBrain({ client, fees: FEES, payments: mockPayments, data });
  const result = await brain.ask([], '[now] hello');
  assert.deepEqual(result, { text: 'Hi from Claude', keep: true });

  const [req] = seen;
  assert.match(req.url, /\/v1\/messages\?beta=true$/);
  assert.equal(req.headers.get('anthropic-beta'), 'server-side-fallback-2026-07-01,thinking-binding-controls-2026-08-01');
  assert.equal(req.headers.get('x-api-key'), 'sk-ant-test');
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.fallbacks, 'default');
  assert.equal(req.body.betas, undefined, 'betas travel as a header, not in the body');
  assert.deepEqual(req.body.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  assert.deepEqual(req.body.cache_control, { type: 'ephemeral' });
  assert.equal(req.body.tool_choice, undefined);
});
