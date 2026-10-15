# Selfmade Events

A booking system where **hosts** post events and **clients** buy tickets.

The [`edge-finder/`](edge-finder/) folder holds a separate, standalone tool for finding value bets at sportsbooks; see its README.

## Features

**Clients**
- Browse and search upcoming events
- Buy one or more ticket types per event (max 10 of each type per order), paying on Stripe's secure checkout (cards, Apple Pay, Google Pay)
- "My tickets" page with a unique code for each ticket, shown at the door

**Hosts**
- Create events with several ticket types (name, price, capacity); save them as drafts or publish them
- Edit events: capacity can't go below tickets sold, and ticket types that have sales can't be removed
- Dashboard with tickets sold, capacity and revenue for each event
- Attendee list and check-in by ticket code (each ticket can be checked in once)
- Cancel an event, which refunds every paid order automatically
- Connect a bank account through Stripe (Payouts page) to receive ticket money directly; dashboard shows earnings after commission
- New hosts are paid 2 days after each event; trusted hosts get daily payouts and can request instant payouts (see [Host payouts](#host-payouts))

**Under the hood**
- Overselling can't happen: seats are reserved with a conditional `UPDATE` inside a SQLite transaction before payment is taken, and are released if payment fails
- Passwords are hashed with bcrypt; sessions are regenerated on login; every form is CSRF-protected; login redirects only go to local paths
- Payments go through Stripe when `STRIPE_SECRET_KEY` is set (see [Payments](#payments)); without it, a mock provider approves every purchase so the app works locally with no credentials. Production refuses to start in mock mode unless `PAYMENTS=mock` is set

## Stack

Node.js 22.13+ · Express 5 · EJS server-rendered views · SQLite through Node's built-in `node:sqlite` (no native build step).

Prices are in pounds sterling (stored in pence). Event times are entered and shown in UK time (GMT/BST), whatever timezone the server runs in. Both are set in `src/format.js`.

## Getting started

```bash
npm install
npm run seed     # optional: demo accounts and events
npm start        # http://localhost:3000
```

Demo logins (after `npm run seed`), password `password123`:
- Host: `host@example.com`
- Client: `client@example.com`

Run the tests with `npm test`.

### Configuration

| Variable         | Default              | Purpose                                         |
|------------------|----------------------|-------------------------------------------------|
| `PORT`           | `3000`               | HTTP port                                       |
| `DATABASE_PATH`  | `selfmade-events.db` | SQLite file                                     |
| `SESSION_SECRET` | random per boot      | Cookie signing secret (required in production)  |
| `NODE_ENV`       | –                    | `production` turns on secure cookies            |
| `STRIPE_SECRET_KEY` | –                 | Stripe secret key; enables real payments        |
| `STRIPE_WEBHOOK_SECRET` | –             | Signing secret for `/stripe/webhook`            |
| `BOOKING_FEE_PERCENT` | `0`             | Buyer-paid fee: % of each paid ticket           |
| `BOOKING_FEE_FIXED_PENCE` | `0`         | Buyer-paid fee: pence per paid ticket           |
| `PLATFORM_COMMISSION_PERCENT` | `0`     | % of ticket sales kept from the host's share    |
| `PAYOUT_HOLD_DAYS_AFTER_EVENT` | `2`    | New hosts are paid this many days after each event |
| `TRUSTED_HOST_MIN_EVENTS` | `3`         | Completed events with sales before a host is trusted |
| `INSTANT_PAYOUT_FEE_PERCENT` | `1`      | Fee passed on to hosts for instant payouts      |
| `INSTANT_PAYOUT_MIN_FEE_PENCE` | `40`   | Minimum instant payout fee                      |
| `APP_URL`        | Render URL           | Public URL used in Stripe redirects (set it when you add a custom domain) |
| `PAYMENTS`       | –                    | `mock` allows production without Stripe (demo)  |

## Payments

Payments use **Stripe Checkout** with **Stripe Connect** (Express accounts):

1. A host opens **Payouts** and connects a bank account through Stripe's onboarding. Stripe handles identity checks. Paid events can't be published until this is done; free events don't need it.
2. A buyer picks tickets. The seats are held for 30 minutes and the buyer is sent to Stripe's payment page.
3. Stripe confirms the payment with a webhook (and again when the buyer returns to the site). The order is marked paid and the tickets appear under My tickets. If checkout is cancelled or expires, the seats are released.
4. The money goes to the host's Stripe account, minus your **application fee** (booking fee + commission), which lands in your Stripe balance. Stripe pays hosts out to their bank automatically.
5. Cancelling an event refunds every buyer in full, reversing the host's transfer and your fee.

With this setup (destination charges), Stripe's processing fee is taken from **your** share. Set your booking fee or commission to at least cover it, or you'll lose money on each sale.

Safety nets: payments that land after a hold expired, or after the event was cancelled, are refunded automatically; a background job every 5 minutes settles checkouts whose webhooks never arrived.

### Host payouts

Hosts' Stripe accounts use a **manual** payout schedule, and the app decides when money moves from a host's Stripe balance to their bank (an hourly job pays each host at most once a day):

| | New hosts (standard) | Trusted hosts |
|---|---|---|
| When they're paid | `PAYOUT_HOLD_DAYS_AFTER_EVENT` (2) days after each event | Daily, as soon as Stripe has cleared the money (about 3 days after a sale) |
| Instant payouts | No | Yes: "Get paid now" on the Payouts page; arrives in about 30 minutes |

Holding new hosts' money until after the event means that if an event is cancelled or a buyer is refunded, the money is still in the host's balance, rather than coming out of yours.

**Becoming trusted:** automatically after `TRUSTED_HOST_MIN_EVENTS` (3) completed events with ticket sales, as long as the host hasn't cancelled an event with sales in the past year. You can override this for any host. On Render, open the service's **Shell** and run:

```bash
npm run host:tier -- host@example.com trusted    # daily + instant payouts
npm run host:tier -- host@example.com standard   # always held until after events
npm run host:tier -- host@example.com auto       # back to the automatic rule
```

**Instant payout fee:** Stripe charges the platform 1% (minimum 40p) for instant payouts. The app passes this on: it first moves the fee from the host's balance to yours (a Stripe *account debit*), then pays out the rest. If the payout fails, the fee is returned. If the fee can't be collected, no instant payout is made and the host is paid on the normal schedule. Test this in Stripe test mode before going live.

**Note:** Stripe's own rules still apply: a new Stripe account's first payout can take up to 7 days, and Stripe may hold funds if it sees unusual activity.

### Setting up Stripe

1. Create a Stripe account at [stripe.com](https://stripe.com) (UK). Use **test mode** first.
2. Enable **Connect** (Dashboard → Connect → Get started) and choose the platform/marketplace option.
3. Copy the secret key (Developers → API keys) into `STRIPE_SECRET_KEY` on Render.
4. Add a webhook endpoint (Developers → Webhooks) at `https://<your-site>/stripe/webhook` with the events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and `checkout.session.expired`. Put its signing secret into `STRIPE_WEBHOOK_SECRET`.
5. Test with card `4242 4242 4242 4242`, any future date and any CVC. When you're ready, repeat steps 3–4 with live keys.

For local testing, the [Stripe CLI](https://stripe.com/docs/stripe-cli) can forward webhooks: `stripe listen --forward-to localhost:3000/stripe/webhook`.

## Deploying to Render

The repo includes a Render Blueprint (`render.yaml`) that sets everything up:

1. Sign in at [render.com](https://render.com) with GitHub, and give Render access to this repository.
2. In the dashboard choose **New → Blueprint**, pick this repository, and click **Apply**.
3. Render builds the app and gives you a URL like `https://selfmade-events.onrender.com`. Every push to the deployed branch redeploys automatically.

What the Blueprint creates:
- A **Starter** web service (about $7/month) in **Frankfurt**, Render's closest region to the UK
- A 1 GB **persistent disk** at `/var/data` that holds the SQLite database (users, events, orders and login sessions). It survives deploys and restarts
- A random `SESSION_SECRET`, plus `NODE_ENV=production` and `DATABASE_PATH`
- Prompts for your Stripe keys, and fee settings defaulting to 0 (see [Payments](#payments))
- A health check at `/healthz`

Notes:
- Render's free plan has no persistent disk, so all data would be wiped on every deploy. That's why the Blueprint uses Starter.
- With a disk attached, the service runs as a single instance, and each deploy has a few seconds of downtime. That's fine at this scale; move to Postgres if you outgrow it.
- **Custom domain:** in the service's **Settings → Custom Domains**, add your domain and create the DNS records Render shows you. Render issues the HTTPS certificate automatically.
- **Backups:** Render takes daily snapshots of persistent disks. You can also download the database file from the service's **Shell**.
- Render deploys the repository's default branch unless you choose another branch in the Blueprint.

## Project layout

```
src/
  app.js          Express app factory (createApp({ db, payments }))
  session-store.js  Login sessions stored in SQLite
  server.js       Entry point
  seed.js         Demo data
  db.js           Schema + transaction helper
  payments.js     Payment provider interface, mock, provider selection
  stripe-payments.js  Stripe Checkout + Connect provider
  orders.js       Order lifecycle: hold seats, confirm, release, refund
  fees.js         Booking fee and commission calculation
  payouts.js      When hosts are paid: held, daily and instant payouts
  cli/host-tier.js  Set a host's payout tier (npm run host:tier)
  routes/
    auth.js       Register / login / logout
    events.js     Public listing, event page, checkout
    tickets.js    "My tickets", return pages from Stripe
    webhooks.js   Stripe webhook
    host.js       Host dashboard, event CRUD, attendees, check-in, cancel
views/            EJS templates
public/           CSS + small client scripts
test/             node:test + supertest integration tests
```

## Before going to production

- **Email:** send order confirmations and cancellation notices.
- **Legal pages:** terms of service (including your refund policy) and a privacy policy.
