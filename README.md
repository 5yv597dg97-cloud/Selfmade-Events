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

Node.js 22.5+ · Express 5 · EJS server-rendered views · SQLite through Node's built-in `node:sqlite` (no native build step).

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

## Project layout

```
src/
  app.js          Express app factory (createApp({ db, payments }))
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
- **Session store:** the default in-memory store resets on restart and only works with a single process. Use a persistent store (e.g. Redis or SQLite).
- **Email:** send order confirmations and cancellation notices.
- **Host payouts:** e.g. Stripe Connect, so hosts receive their revenue directly.
