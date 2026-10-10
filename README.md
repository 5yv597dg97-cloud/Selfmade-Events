# Selfmade Events

A booking system where **hosts** post events and **clients** buy tickets.

## Features

**Clients**
- Browse and search upcoming events
- Buy one or more ticket types per event (max 10 of each type per order)
- "My tickets" page with a unique code for each ticket, shown at the door

**Hosts**
- Create events with several ticket types (name, price, capacity); save them as drafts or publish them
- Edit events: capacity can't go below tickets sold, and ticket types that have sales can't be removed
- Dashboard with tickets sold, capacity and revenue for each event
- Attendee list and check-in by ticket code (each ticket can be checked in once)
- Cancel an event, which refunds every paid order automatically

**Under the hood**
- Overselling can't happen: seats are reserved with a conditional `UPDATE` inside a SQLite transaction before payment is taken, and are released if payment fails
- Passwords are hashed with bcrypt; sessions are regenerated on login; every form is CSRF-protected; login redirects only go to local paths
- Payments are pluggable (`src/payments.js`). The default mock provider approves every charge, so the app works without any credentials

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

## Deploying to Render

The repo includes a Render Blueprint (`render.yaml`) that sets everything up:

1. Sign in at [render.com](https://render.com) with GitHub, and give Render access to this repository.
2. In the dashboard choose **New → Blueprint**, pick this repository, and click **Apply**.
3. Render builds the app and gives you a URL like `https://selfmade-events.onrender.com`. Every push to the deployed branch redeploys automatically.

What the Blueprint creates:
- A **Starter** web service (about $7/month) in **Frankfurt**, Render's closest region to the UK
- A 1 GB **persistent disk** at `/var/data` that holds the SQLite database (users, events, orders and login sessions). It survives deploys and restarts
- A random `SESSION_SECRET`, plus `NODE_ENV=production` and `DATABASE_PATH`
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
  payments.js     Payment provider interface + mock
  routes/
    auth.js       Register / login / logout
    events.js     Public listing, event page, checkout
    tickets.js    "My tickets"
    host.js       Host dashboard, event CRUD, attendees, check-in, cancel
views/            EJS templates
public/           CSS + small client scripts
test/             node:test + supertest integration tests
```

## Before going to production

- **Real payments:** add a provider such as Stripe Checkout by implementing `charge`/`refund` in `src/payments.js`. For hosted checkout, keep orders `pending` and confirm them from a webhook.
- **Email:** send order confirmations and cancellation notices.
- **Host payouts:** e.g. Stripe Connect, so hosts receive their revenue directly.
