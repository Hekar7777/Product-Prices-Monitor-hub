-- ---------------------------------------------------------------------------
-- Flipkart Price Change Monitor - initial Postgres schema (Supabase)
--
-- Paste this into the Supabase SQL editor for a new project and run it once.
-- This mirrors the previous SQLite schema with a few deliberate Postgres-
-- native adjustments:
--   - `id` columns use `generated always as identity` instead of AUTOINCREMENT.
--   - Boolean flags (`monitoring_enabled`, `is_baseline`, `read`) are native
--     `boolean` instead of SQLite's 0/1 integers.
--   - Timestamp columns stay `text` storing ISO-8601 UTC strings
--     (e.g. `2026-08-30T14:05:00.000Z`), exactly as the application already
--     generates them via `new Date().toISOString()`. This preserves the
--     app's existing lexicographic string-comparison behaviour for range
--     filters (`timestamp >= ?`) and avoids any drift from `timestamptz`
--     round-tripping through PostgREST in a different string format.
--   - Money columns stay `double precision` (SQLite's REAL was also a float),
--     so PostgREST returns plain JSON numbers, matching what the app's
--     `toMoney()` coercion already expects.
--
-- Security note: this project uses the Supabase *service role* key from the
-- server only (never exposed to the frontend), which bypasses Row Level
-- Security entirely. RLS is therefore left at its default (disabled) here.
-- Do NOT grant the anon/public roles any privileges on these tables.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- products: one row per monitored Flipkart URL
-- ---------------------------------------------------------------------------
create table products (
  id                   bigint generated always as identity primary key,
  url                  text    not null,
  canonical_key        text    not null unique,
  product_name         text    not null,
  image_url            text,
  currency             text    not null default 'INR',

  current_price        double precision,
  previous_price       double precision,
  lowest_price         double precision,
  highest_price        double precision,
  mrp                  double precision,

  availability         text,
  seller               text,

  monitoring_enabled   boolean not null default true,
  price_change_count   integer not null default 0,
  consecutive_failures integer not null default 0,

  last_status          text    not null default 'pending',
  last_error_code      text,
  last_error_message   text,

  created_at           text    not null,
  updated_at           text    not null,
  last_checked_at      text,
  last_attempted_at    text,
  last_price_change_at text
);

create unique index idx_products_canonical_key on products (canonical_key);
-- Partial index: the cron-triggered check only ever scans products it may check.
create index idx_products_active_due
  on products (last_attempted_at) where monitoring_enabled = true;
create index idx_products_monitoring_enabled on products (monitoring_enabled);
create index idx_products_last_checked_at on products (last_checked_at);
create index idx_products_created_at on products (created_at);

-- ---------------------------------------------------------------------------
-- price_history: meaningful price observations (baseline + changes)
-- ---------------------------------------------------------------------------
create table price_history (
  id           bigint generated always as identity primary key,
  product_id   bigint  not null references products (id) on delete cascade,
  price        double precision not null,
  currency     text    not null default 'INR',
  mrp          double precision,
  availability text,
  seller       text,
  source_url   text    not null,
  is_baseline  boolean not null default false,
  timestamp    text    not null
);

create index idx_price_history_product_ts on price_history (product_id, timestamp);
create index idx_price_history_timestamp on price_history (timestamp);

-- ---------------------------------------------------------------------------
-- price_changes: one row per detected change from the last known price
-- ---------------------------------------------------------------------------
create table price_changes (
  id                bigint  generated always as identity primary key,
  product_id        bigint  not null references products (id) on delete cascade,
  price_history_id  bigint  references price_history (id) on delete set null,
  old_price         double precision not null,
  new_price         double precision not null,
  absolute_change   double precision not null,
  percentage_change double precision not null,
  direction         text    not null check (direction in ('up', 'down')),
  currency          text    not null default 'INR',
  detected_at       text    not null
);

create index idx_price_changes_product_detected on price_changes (product_id, detected_at);
create index idx_price_changes_detected_at on price_changes (detected_at);

-- ---------------------------------------------------------------------------
-- notifications: delivered messages, one row per provider per change
-- ---------------------------------------------------------------------------
create table notifications (
  id              bigint  generated always as identity primary key,
  product_id      bigint  references products (id) on delete cascade,
  price_change_id bigint  references price_changes (id) on delete cascade,
  channel         text    not null default 'in_app',
  type            text    not null,
  title           text    not null,
  message         text    not null,
  payload         text,
  read            boolean not null default false,
  delivery_status text    not null default 'delivered',
  delivery_error  text,
  created_at      text    not null
);

create index idx_notifications_read_created on notifications (read, created_at);
create index idx_notifications_product on notifications (product_id, created_at);
create index idx_notifications_price_change on notifications (price_change_id);

-- ---------------------------------------------------------------------------
-- check_logs: audit trail of every check attempt, success or failure
-- ---------------------------------------------------------------------------
create table check_logs (
  id             bigint  generated always as identity primary key,
  product_id     bigint  references products (id) on delete cascade,
  status         text    not null check (status in ('success', 'failed', 'skipped')),
  outcome        text,
  price          double precision,
  error_code     text,
  error_message  text,
  attempts       integer not null default 1,
  duration_ms    integer,
  strategy       text,
  -- 'scheduler' | 'manual' | 'initial'. Named trigger_source because
  -- TRIGGER is a reserved SQL keyword.
  trigger_source text    not null default 'scheduler',
  started_at     text    not null,
  finished_at    text    not null
);

create index idx_check_logs_product_finished on check_logs (product_id, finished_at);
create index idx_check_logs_finished_at on check_logs (finished_at);
create index idx_check_logs_status on check_logs (status, finished_at);

-- ---------------------------------------------------------------------------
-- settings: runtime configuration edited from the Settings page
-- ---------------------------------------------------------------------------
create table settings (
  key        text primary key,
  value      text not null,
  updated_at text not null
);
