# Selfmade Events

A booking system where **hosts** post events and **clients** buy tickets, and **you, the site owner, earn money** from every paid ticket and from hosts who pay to feature their events. See [Making money](#making-money).

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
- Pay to **feature** a live event at the top of the homepage for 1, 3, 7 or 14 days; buying more days extends it

**Site owner**
- **Earnings** page: income this month and all time (booking fees, commission, featured listings), estimated Stripe card fees and profit, a month-by-month table, top events, and what one ticket earns everyone at your current prices
- A warning on that page, and in the server log, if your fees don't cover Stripe's card fee

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
- Site owner: `owner@example.com` (start the app with `ADMIN_EMAILS=owner@example.com npm start` to see the Earnings page)

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
| `BOOKING_FEE_PERCENT` | `0` (Render: `5`) | Buyer-paid fee: % of each paid ticket       |
| `BOOKING_FEE_FIXED_PENCE` | `0` (Render: `30`) | Buyer-paid fee: pence per paid ticket    |
| `PLATFORM_COMMISSION_PERCENT` | `0`     | % of ticket sales kept from the host's share    |
| `FEATURED_PRICE_PER_DAY_PENCE` | `200`  | What hosts pay per day to feature an event; `0` turns featuring off |
| `ADMIN_EMAILS`   | –                    | Comma-separated emails of site owners who can see the Earnings page |
| `APP_URL`        | Render URL           | Public URL used in Stripe redirects (set it when you add a custom domain) |
| `PAYMENTS`       | –                    | `mock` allows production without Stripe (demo)  |

## Making money

The site earns from two sources, both paid straight into your Stripe balance:

1. **Booking fees and commission on paid tickets.** The Render Blueprint sets a booking fee of **5% + 30p per paid ticket**, paid by the buyer, and no commission, so hosts keep 100% of their ticket price (a good selling point). On a £10 ticket the buyer pays £10.80, the host gets £10.00 and you keep 80p, about 44p after Stripe's card fee. Free tickets carry no fee.
2. **Featured listings.** Hosts pay **£2 a day** (by default) to show an event in a Featured section at the top of the homepage. They pay by card on Stripe; the money goes to you, not through Connect. If the event is cancelled before the payment lands, it's refunded automatically. Days already featured aren't refunded if the host later cancels.

Stripe's card fee (1.5% + 20p for UK cards, up to 3.25% + 20p for cards from abroad) comes out of **your** share, so with zero fees you'd lose money on every sale. 5% + 30p covers it on every ticket price, even for cards from abroad. Stripe Connect also charges platforms for each host account it pays out to; check [Stripe's Connect pricing](https://stripe.com/gb/connect/pricing). Change any price in Render under **Environment**; the service restarts with the new values.

**See your earnings:** sign up on the site with your own email, then set `ADMIN_EMAILS` to that email in Render. An **Earnings** link appears in the menu. Sign up *before* setting the variable: accounts aren't email-verified, so whoever registers an address first owns it.

Ideas for more income later: a commission on top of the booking fee, monthly plans for busy hosts, or paid add-ons such as email campaigns to past buyers.

## Payments

Payments use **Stripe Checkout** with **Stripe Connect** (Express accounts):

1. A host opens **Payouts** and connects a bank account through Stripe's onboarding. Stripe handles identity checks. Paid events can't be published until this is done; free events don't need it.
2. A buyer picks tickets. The seats are held for 30 minutes and the buyer is sent to Stripe's payment page.
3. Stripe confirms the payment with a webhook (and again when the buyer returns to the site). The order is marked paid and the tickets appear under My tickets. If checkout is cancelled or expires, the seats are released.
4. The money goes to the host's Stripe account, minus your **application fee** (booking fee + commission), which lands in your Stripe balance. Stripe pays hosts out to their bank automatically.
5. Cancelling an event refunds every buyer in full, reversing the host's transfer and your fee.

With this setup (destination charges), Stripe's processing fee is taken from **your** share. Set your booking fee or commission to at least cover it, or you'll lose money on each sale.

Safety nets: payments that land after a hold expired, or after the event was cancelled, are refunded automatically; a background job every 5 minutes settles checkouts whose webhooks never arrived.

### Setting up Stripe

1. Create a Stripe account at [stripe.com](https://stripe.com) (UK). Use **test mode** first.
2. Enable **Connect** (Dashboard → Connect → Get started) and choose the platform/marketplace option.
3. Copy the secret key (Developers → API keys) into `STRIPE_SECRET_KEY` on Render.
4. Add a webhook endpoint (Developers → Webhooks) at `https://<your-site>/stripe/webhook` with the events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and `checkout.session.expired`. Put its signing secret into `STRIPE_WEBHOOK_SECRET`. The same endpoint confirms featured-listing payments.
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
- Prompts for your Stripe keys and `ADMIN_EMAILS`, and sets fees of 5% + 30p per paid ticket and £2 a day for featured listings (see [Making money](#making-money))
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
  promotions.js   Featured listings: pay, start or extend the featured period, refund
  fees.js         Booking fee and commission calculation, card-fee estimate
  routes/
    auth.js       Register / login / logout
    events.js     Public listing, event page, checkout
    tickets.js    "My tickets", return pages from Stripe
    webhooks.js   Stripe webhook
    host.js       Host dashboard, event CRUD, attendees, check-in, cancel, featuring
    admin.js      Site owner's Earnings page
views/            EJS templates
public/           CSS + small client scripts
test/             node:test + supertest integration tests
```

## Before going to production

- **Email:** send order confirmations and cancellation notices.
- **Legal pages:** terms of service (including your refund policy) and a privacy policy.
