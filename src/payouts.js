/**
 * Host payout policy.
 *
 * Hosts' Stripe accounts are on a manual payout schedule, so this app decides when
 * ticket money leaves a host's Stripe balance for their bank:
 *
 *   - Standard hosts (new): earnings from an event are held until PAYOUT_HOLD_DAYS_AFTER_EVENT
 *     days after it starts. If the event is cancelled or goes wrong, refunds come out of
 *     the host's balance instead of the platform's.
 *   - Trusted hosts: everything available is paid out daily, and they can request an
 *     Instant Payout (arrives in minutes) for a fee passed on from Stripe.
 *
 * A host becomes trusted automatically after TRUSTED_HOST_MIN_EVENTS completed events with
 * sales and no cancelled events with sales in the past year. `payout_tier` overrides this:
 * 'trusted' or 'standard' (set with `npm run host:tier`), or 'auto' for the rule.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Stripe won't pay out tiny amounts; skip below this. */
const MIN_PAYOUT_PENCE = 100;

export function payoutConfigFromEnv(env = process.env) {
  const num = (name, fallback, { min = 0, max = Infinity, integer = false } = {}) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
      throw new Error(`${name} must be a ${integer ? 'whole ' : ''}number between ${min} and ${max}`);
    }
    return n;
  };
  return {
    holdDaysAfterEvent: num('PAYOUT_HOLD_DAYS_AFTER_EVENT', 2, { max: 60 }),
    trustedMinEvents: num('TRUSTED_HOST_MIN_EVENTS', 3, { max: 1000, integer: true }),
    instantFeePercent: num('INSTANT_PAYOUT_FEE_PERCENT', 1, { max: 10 }),
    instantMinFeePence: num('INSTANT_PAYOUT_MIN_FEE_PENCE', 40, { max: 1000, integer: true }),
  };
}

export const DEFAULT_PAYOUT_CONFIG = payoutConfigFromEnv({});

export function createPayouts({ db, payments, config = DEFAULT_PAYOUT_CONFIG, now = () => Date.now() }) {
  const completedEvents = db.prepare(`
    SELECT COUNT(DISTINCT e.id) AS n FROM events e
    JOIN orders o ON o.event_id = e.id AND o.status = 'paid'
    WHERE e.host_id = ? AND e.status = 'published' AND e.starts_at < ?`);
  const recentCancellations = db.prepare(`
    SELECT COUNT(DISTINCT e.id) AS n FROM events e
    JOIN orders o ON o.event_id = e.id AND o.status IN ('paid', 'refunded')
    WHERE e.host_id = ? AND e.status = 'cancelled' AND e.starts_at > ?`);
  const heldEarnings = db.prepare(`
    SELECT COALESCE(SUM(o.subtotal_cents - o.commission_cents), 0) AS pence
    FROM orders o JOIN events e ON e.id = o.event_id
    WHERE e.host_id = ? AND o.status = 'paid' AND e.status != 'cancelled' AND e.starts_at > ?`);
  const nextRelease = db.prepare(`
    SELECT MIN(e.starts_at) AS starts_at FROM events e JOIN orders o ON o.event_id = e.id AND o.status = 'paid'
    WHERE e.host_id = ? AND e.status != 'cancelled' AND e.starts_at > ?`);
  const getHost = db.prepare('SELECT * FROM users WHERE id = ?');
  const dueHosts = db.prepare(`
    SELECT * FROM users
    WHERE role = 'host' AND stripe_account_id IS NOT NULL AND stripe_charges_enabled = 1
      AND (last_payout_run_at IS NULL OR last_payout_run_at < ?)`);
  const markRun = db.prepare('UPDATE users SET last_payout_run_at = ? WHERE id = ?');
  const logPayout = db.prepare(`
    INSERT OR IGNORE INTO payouts (host_id, stripe_payout_id, amount_cents, fee_cents, method, arrival_date)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const recentPayouts = db.prepare('SELECT * FROM payouts WHERE host_id = ? ORDER BY id DESC LIMIT 10');
  const setTier = db.prepare('UPDATE users SET payout_tier = ? WHERE id = ?');

  /** Events starting after this moment are still within their hold period. */
  const holdCutoff = () => new Date(now() - config.holdDaysAfterEvent * DAY_MS).toISOString();

  function isTrusted(host) {
    if (host.payout_tier === 'trusted') return true;
    if (host.payout_tier === 'standard') return false;
    const yearAgo = new Date(now() - 365 * DAY_MS).toISOString();
    return completedEvents.get(host.id, holdCutoff()).n >= config.trustedMinEvents
      && recentCancellations.get(host.id, yearAgo).n === 0;
  }

  /** Earnings that must stay in the host's balance for now (pence). */
  function heldFor(host) {
    return isTrusted(host) ? 0 : heldEarnings.get(host.id, holdCutoff()).pence;
  }

  /** Fee passed on to the host for an Instant Payout of `amount` pence. */
  function instantFeeFor(amount) {
    return Math.max(config.instantMinFeePence, Math.ceil((amount * config.instantFeePercent) / 100));
  }

  /** What the host's Payouts page shows. Balance figures need a Stripe call. */
  async function summary(hostId) {
    const host = getHost.get(hostId);
    const trusted = isTrusted(host);
    const result = {
      trusted,
      tier: host.payout_tier,
      holdDays: config.holdDaysAfterEvent,
      trustedMinEvents: config.trustedMinEvents,
      completedEvents: completedEvents.get(host.id, holdCutoff()).n,
      held: heldFor(host),
      nextReleaseAt: null,
      recent: recentPayouts.all(host.id),
      balance: null,
      instant: null,
    };
    const next = nextRelease.get(host.id, holdCutoff()).starts_at;
    if (next && !trusted) result.nextReleaseAt = new Date(new Date(next).getTime() + config.holdDaysAfterEvent * DAY_MS).toISOString();
    if (payments.requiresHostAccount && host.stripe_account_id && host.stripe_charges_enabled) {
      try {
        result.balance = await payments.hostAccounts.balance(host.stripe_account_id);
        if (trusted && result.balance.instantAvailable > 0) {
          const fee = instantFeeFor(result.balance.instantAvailable);
          if (result.balance.instantAvailable - fee >= MIN_PAYOUT_PENCE) {
            result.instant = { available: result.balance.instantAvailable, fee, receive: result.balance.instantAvailable - fee };
          }
        }
      } catch (err) {
        console.error(`Host ${host.id}: could not load Stripe balance:`, err.message);
      }
    }
    return result;
  }

  /** Pay out whatever this host may receive now. Returns the payout, or null. */
  async function payOutHost(host) {
    const { available } = await payments.hostAccounts.balance(host.stripe_account_id);
    const amount = available - heldFor(host);
    if (amount < MIN_PAYOUT_PENCE) return null;
    const day = new Date(now()).toISOString().slice(0, 10);
    const payout = await payments.hostAccounts.payout(host.stripe_account_id, {
      amount,
      method: 'standard',
      idempotencyKey: `payout-${host.id}-${day}-${amount}`,
      description: 'Selfmade Events ticket sales',
    });
    logPayout.run(host.id, payout.id, amount, 0, 'standard', payout.arrivalDate);
    return payout;
  }

  /** Daily job: pay each connected host at most once a day. */
  async function runDue() {
    if (!payments.requiresHostAccount) return;
    const dayAgo = new Date(now() - DAY_MS + 5 * 60 * 1000).toISOString(); // a little slack for the job interval
    for (const host of dueHosts.all(dayAgo)) {
      try {
        await payOutHost(host);
        markRun.run(new Date(now()).toISOString(), host.id);
      } catch (err) {
        console.error(`Host ${host.id}: payout failed:`, err.message);
      }
    }
  }

  /**
   * Trusted host asks to be paid now. Collects the fee from their balance first, so the
   * platform isn't left paying Stripe's Instant Payout charge, then pays out the rest.
   */
  async function instant(hostId) {
    const host = getHost.get(hostId);
    if (!payments.requiresHostAccount || !host?.stripe_charges_enabled) throw new PayoutError('Payouts are not set up.');
    if (!isTrusted(host)) throw new PayoutError('Instant payouts are available once your account is trusted.');
    const { instantAvailable } = await payments.hostAccounts.balance(host.stripe_account_id);
    const fee = instantFeeFor(instantAvailable);
    const amount = instantAvailable - fee;
    if (amount < MIN_PAYOUT_PENCE) throw new PayoutError('There is no money available for an instant payout right now.');

    const stamp = `${host.id}-${instantAvailable}-${new Date(now()).toISOString().slice(0, 16)}`;
    try {
      await payments.hostAccounts.collectFee(host.stripe_account_id, { amount: fee, idempotencyKey: `instant-fee-${stamp}`, description: 'Instant payout fee' });
    } catch (err) {
      console.error(`Host ${host.id}: instant payout fee collection failed:`, err.message);
      throw new PayoutError('Instant payouts are unavailable right now. Your money will be paid out on the normal schedule.');
    }
    let payout;
    try {
      payout = await payments.hostAccounts.payout(host.stripe_account_id, {
        amount, method: 'instant', idempotencyKey: `instant-${stamp}`, description: 'Selfmade Events instant payout',
      });
    } catch (err) {
      console.error(`Host ${host.id}: instant payout failed after collecting the fee:`, err.message);
      try {
        await payments.hostAccounts.returnFee(host.stripe_account_id, { amount: fee, idempotencyKey: `instant-fee-return-${stamp}` });
      } catch (returnErr) {
        console.error(`Host ${host.id}: could not return instant payout fee of ${fee}p:`, returnErr.message);
      }
      throw new PayoutError("Your bank account or card can't receive instant payouts. Your money will be paid out on the normal schedule.");
    }
    logPayout.run(host.id, payout.id, amount, fee, 'instant', payout.arrivalDate);
    return { amount, fee, payout };
  }

  function setHostTier(hostId, tier) {
    if (!['auto', 'trusted', 'standard'].includes(tier)) throw new Error(`Unknown payout tier: ${tier}`);
    return setTier.run(tier, hostId).changes === 1;
  }

  return { isTrusted, heldFor, instantFeeFor, summary, runDue, payOutHost, instant, setHostTier };
}

export class PayoutError extends Error {}
