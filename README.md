# Flipkart Price Change Monitor

Monitors Flipkart product URLs and notifies you **whenever the listed price changes** from the
last successfully observed price.

There is no target price, no threshold, no minimum discount and nothing to configure per product.
The only alert condition is:

> current price ≠ last successfully observed price → record a change and notify

If the price has not changed, nothing happens. If a check fails, the last valid price is kept and
no alert is raised.

---

## Quick start

```bash
npm install                 # installs both workspaces
npm run playwright:install  # optional: Chromium, for pages that need JS to show a price
cp .env.example .env        # optional: all settings have sensible defaults

npm run dev                 # API on :4000, dashboard on :5173
```

Open <http://localhost:5173>, paste a Flipkart product URL, and that is the whole setup.

For a single-port production run:

```bash
npm run build
npm start                   # serves the API and the built dashboard on :4000
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Backend (tsx watch) and frontend (Vite) together |
| `npm run build` | Compiles the server and builds the dashboard |
| `npm start` | Runs the compiled server, serving the dashboard from the same port |
| `npm test` | Full test suite (176 tests, no network access) |
| `npm run typecheck` | Type-checks both workspaces |
| `npm --workspace server run verify:e2e` | Boots the real server + database + scheduler and asserts the whole flow (110 checks) |
| `npm run playwright:install` | Downloads Chromium for browser-based extraction |

## How monitoring works

A background scheduler inside the server process re-checks every monitored product on an interval
(default **15 minutes**). It does not depend on a browser being open — closing the dashboard has no
effect on monitoring.

For each product the scheduler:

1. Fetches the product page.
2. Extracts the current selling price.
3. Compares it against the last successfully recorded price.

| Result | What is written |
| --- | --- |
| **First ever price** | Baseline: price, history row, `last_checked_at`. **No notification.** |
| **Same price** | `last_checked_at` only. No history row, no change, no notification. |
| **Different price** | History row, `price_changes` row (old, new, absolute, percentage, direction), product price fields, notification. |
| **Failed check** | Attempt bookkeeping only. `current_price` and `last_checked_at` are untouched. No notification. |

Price history therefore records *movement*, not one row per scheduler tick.

### Safety properties

- Ticks never overlap.
- A product is never checked twice concurrently — the guard covers both scheduled and manual
  checks, so clicking "Check now" during a sweep is refused rather than duplicated.
- Concurrency is capped by the `maxConcurrentChecks` setting.
- One product failing never aborts a sweep.
- Prices are compared at paise granularity, so floating-point representation can never fabricate a
  change.

## Extraction

All scraping sits behind one interface, `FlipkartProductFetcher`
(`server/src/fetcher/types.ts`). The rest of the application only ever receives structured data:

```
{ product_name, price, mrp, image_url, availability, seller, url }
```

Two implementations are composed with retries and escalation:

1. **`http`** — plain request plus HTML parsing. Fast, no browser.
2. **`playwright`** — real Chromium, used when the price is not in the server-rendered HTML.

Set the chain with `FETCH_STRATEGY` (`auto` | `http` | `playwright`). `auto` is the default and
escalates from HTTP to the browser only when the page loaded but no price could be read.

Because Flipkart changes its markup regularly, five independent parsers are tried in order of
reliability and the first one that yields a usable price wins: `json-ld` → `initial-state` → `dom`
→ `meta` → `heuristic`. Nothing is hard-coded per product; every value comes from the fetched
document. As of the last verification run, live Flipkart product pages are read successfully over
plain HTTP via their schema.org JSON-LD block.

Retries apply only to transient failures (timeout, network, 5xx). `CAPTCHA` is never retried and
never escalated.

### Failure classification

Every failure maps to a code, is logged, is recorded in the check log, and leaves the stored price
alone: `INVALID_URL`, `NETWORK_ERROR`, `TIMEOUT`, `HTTP_ERROR`, `PRODUCT_REMOVED`, `CAPTCHA`,
`LOGIN_REQUIRED`, `PRODUCT_UNAVAILABLE`, `PRICE_NOT_FOUND`, `PARSE_ERROR`, `BROWSER_UNAVAILABLE`,
`BROWSER_ERROR`, `UNKNOWN`.

## Notifications

Two providers ship: **in-app** (the dashboard feed) and **Web Push** (a real browser/OS
notification, including while the tab is closed - see [Web Push notifications](#web-push-notifications)
below). A price change produces, for example:

```
Price dropped
iPhone 16
₹69,999 → ₹67,999
↓ ₹2,000 (2.86%)
```

Each notification also carries a structured payload, so clients never parse that text.

Adding another channel means implementing `NotificationProvider` and registering it — the
monitoring pipeline does not change:

```ts
class EmailProvider implements NotificationProvider {
  readonly channel = 'email';
  isEnabled() { return Boolean(env.smtpUrl); }
  async send(message) { /* email message.message; return { ok } */ }
}

notificationService.register(new EmailProvider());
```

`NotificationService` writes one `notifications` row per channel per change, so a broken provider
is recorded as a failed delivery without affecting the others or the recorded price change.

## Web Push notifications

Push delivery uses the standard Service Worker + Push API + Notifications API stack, authenticated
with VAPID. The private key never leaves the server.

### Enabling it (as the operator)

1. Generate a VAPID keypair:
   ```bash
   npx web-push generate-vapid-keys
   ```
2. Put the keys in `.env`:
   ```
   VAPID_PUBLIC_KEY=...
   VAPID_PRIVATE_KEY=...
   VAPID_SUBJECT=mailto:you@example.com
   ```
3. Run the migration `server/supabase/migrations/0003_web_push_subscriptions.sql` against your
   Supabase project (see [Database](#database)).

Without these, `WebPushNotificationProvider.isEnabled()` returns `false` and the channel is
skipped - nothing else in the app is affected.

### Enabling it (as a user, in the browser)

Open **Settings** → **Push notifications** → **Enable Notifications**. This is the only place
permission is requested; the app never asks on page load. Clicking it:

1. Requests browser notification permission.
2. Registers `web/public/sw.js` as a service worker.
3. Creates a `PushSubscription` and POSTs it to `/api/push-subscriptions`.

The button then shows **Notifications: Enabled**. Clicking **Disable notifications** unsubscribes
in the browser and deletes the stored subscription.

### Browser / platform support

| Platform | Support | Notes |
| --- | --- | --- |
| Desktop Chrome, Edge, Firefox | Full | Notifications are delivered even with every tab for the site closed, as long as the browser application itself is still running (fully quitting the browser stops delivery until it is reopened). |
| Desktop Safari (macOS) | Full (Safari 16+) | Uses the same Web Push standard as other browsers. |
| Android Chrome/Firefox | Full | Delivered even with the browser fully closed/killed, via the OS push service, matching native app behaviour. |
| iPhone/iPad Safari | Requires Home Screen install | Since iOS/iPadOS 16.4, Web Push works in Safari **only after the site is added to the Home Screen** ("Add to Home Screen", which installs it as a standalone PWA) and opened from that icon at least once. Push notifications will not work in a normal Safari browser tab on iOS. |
| iPhone/iPad Chrome/Edge | Same as Safari | These browsers use Apple's WebKit push implementation on iOS, so the same Home Screen requirement applies. |

This project has not been manually verified against a real iPhone in this environment - the table
above reflects Apple's and browser vendors' documented behaviour, not an in-house test. Verify on
an actual device before relying on it.

Regardless of platform, push delivery always requires: the user granted notification permission,
the subscription is still valid (see below), and the browser/OS push service is reachable.

### Expired subscriptions

If a push service responds with HTTP 404 or 410 for a given subscription (meaning it will never
accept another message), the server deletes that row from `web_push_subscriptions` immediately
after the send attempt. A delivery failure for one subscription - expired or otherwise - never
fails the price-check job; see `NotificationService.notifyPriceChange`.

## Settings

Editable at runtime from the Settings page, stored in the database:

- Monitoring interval (default 15 minutes)
- Enable/disable monitoring globally
- Maximum concurrent checks
- Request timeout
- Fetch attempts per strategy
- In-app notifications on/off
- Check-log retention

`.env` values seed these on first boot; after that the database is the source of truth. There is
deliberately no target-price or threshold setting.

## Project layout

```
server/
  src/
    api/          HTTP routes, DTO serializers, error translation
    app/          composition root and Express wiring
    config/       environment loading
    db/           SQLite driver wrapper and migrations
    domain/       money maths and domain types
    fetcher/      Flipkart extraction (the only scraping code)
    notifications/ provider abstraction, in-app provider, message formatting
    repositories/ data access
    scheduler/    background monitoring loop
    services/     product, price comparison, settings
  scripts/        end-to-end verification
  tests/          vitest suite with a fake fetcher
web/
  src/            React dashboard (dashboard, product detail, notifications, settings, logs)
```

## Database

SQLite via Node's built-in `node:sqlite`, so there is no native build step and no external service.
The file lives at `DATABASE_PATH` (default `server/data/monitor.db`) and migrations run on boot.

Tables: `products`, `price_history`, `price_changes`, `notifications`, `check_logs`, `settings`,
`schema_migrations`, with indexes on product ids, timestamps and active monitoring.

Timestamps are ISO-8601 UTC strings. Money is stored as `REAL` and every comparison goes through
`domain/money.ts`.

> Under `NODE_ENV=test` the database is always in-memory, even if `DATABASE_PATH` is set, so a test
> run can never touch real data. The server logs a warning if it detects that combination.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness, database and scheduler state |
| `GET` | `/api/overview` | Dashboard counters |
| `GET` | `/api/products` | List products (`?search`, `?sort`, `?status`) |
| `POST` | `/api/products` | Add by URL (400 invalid, 409 duplicate, 422 unreadable) |
| `GET` | `/api/products/:id` | Product plus statistics |
| `PATCH` | `/api/products/:id` | Pause/resume monitoring |
| `DELETE` | `/api/products/:id` | Remove product and its history |
| `POST` | `/api/products/:id/check` | Check now (409 if one is already running) |
| `GET` | `/api/products/:id/history` | Price series (`?range=24h\|7d\|30d\|3m\|all`) |
| `GET` | `/api/products/:id/changes` | Detected changes |
| `GET` | `/api/products/:id/logs` | Check attempts for this product |
| `GET` | `/api/notifications` | Feed (`?unread=true`) |
| `POST` | `/api/notifications/:id/read`, `/read-all` | Mark read |
| `DELETE` | `/api/notifications/:id`, `/api/notifications` | Delete one / all |
| `GET`/`PATCH` | `/api/settings` | Read/update settings |
| `GET` | `/api/scheduler`, `POST /api/scheduler/run` | Scheduler status, run a sweep now |
| `GET` | `/api/logs/checks`, `/api/logs/app` | Check audit trail, recent structured logs |
| `GET` | `/api/push-subscriptions/vapid-public-key` | Public VAPID key for `pushManager.subscribe()` |
| `POST` | `/api/push-subscriptions` | Store a browser's `PushSubscription` |
| `DELETE` | `/api/push-subscriptions` | Remove a subscription by `endpoint` |

## Logging

Structured records (pretty in development, JSON with `LOG_FORMAT=json`, optionally appended to
`LOG_FILE`). Notable events: `product.check.started`, `product.check.succeeded`,
`product.check.failed`, `price.unchanged`, `price.changed`, `notification.created`,
`extraction.error`, `scheduler.tick.started`, `scheduler.tick.finished`, `scheduler.error`.

The last 500 records are also queryable at `/api/logs/app` and shown on the Logs page.

## Security notes

- **No authentication.** This is a single-user local tool and binds to `127.0.0.1` by default. If
  you expose it on another interface, put an authenticating reverse proxy in front of it first —
  anyone who can reach the port can read and modify the monitored product list. The server logs a
  warning when bound to all interfaces.
- No Flipkart account is used or needed. Only public product pages are read.
- No CAPTCHA solving, login bypass or anti-bot evasion. When a page cannot be read the check is
  recorded as failed and the last valid price is kept.
- Secrets stay out of source control; `.env` is git-ignored and `.env.example` documents every
  variable.

Be considerate with the monitoring interval — a short interval means more requests to Flipkart.

## Testing

```bash
npm test                                  # 176 unit and integration tests
npm --workspace server run verify:e2e     # 110 end-to-end checks
```

Flipkart is mocked in both. The unit suite injects a fake `FlipkartProductFetcher` and parses saved
HTML fixtures; the end-to-end script boots the real HTTP server, a real on-disk database and the
real scheduler, substituting only the outermost network call so the run is deterministic and sends
no traffic to Flipkart.

Covered: adding a product, invalid URLs, baseline behaviour, unchanged price, price drop, price
increase, percentage maths, failed scrapes, missing prices, deletion cascades, pause/resume,
scheduler duplicate prevention, concurrency limits, and notification creation.
