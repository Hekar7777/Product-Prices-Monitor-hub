-- ---------------------------------------------------------------------------
-- Web Push subscriptions (replaces Telegram).
--
-- One row per browser/device PushSubscription created via the frontend's
-- "Enable Notifications" control (Service Worker + Push API). When a price
-- change fires, the server sends an encrypted Web Push message to every row
-- here using VAPID authentication. There is no per-user product list -
-- every subscription receives every price-change notification, mirroring
-- the previous Telegram behaviour.
--
-- `endpoint` is unique because the browser hands out exactly one endpoint per
-- subscription and re-subscribing (e.g. after clearing site data) creates a
-- new one; upserting on `endpoint` keeps re-enabling notifications from the
-- same browser idempotent instead of accumulating duplicate rows.
-- ---------------------------------------------------------------------------
create table web_push_subscriptions (
  id         bigint generated always as identity primary key,
  endpoint   text    not null unique,
  p256dh     text    not null,
  auth       text    not null,
  created_at text    not null,
  updated_at text    not null
);

create index idx_web_push_subscriptions_endpoint on web_push_subscriptions (endpoint);

-- ---------------------------------------------------------------------------
-- Deprecate Telegram.
--
-- Telegram notifications have been replaced by Web Push (see above). The
-- `subscribers` table (created in 0002_add_telegram_subscribers.sql) is no
-- longer read or written by the application. It is dropped here rather than
-- merely left unused, since it stored Telegram chat ids that serve no
-- purpose without the removed Telegram provider/webhook.
--
-- If you still need the old chat ids for some external purpose, export them
-- before running this migration:
--   select chat_id, created_at from subscribers;
-- ---------------------------------------------------------------------------
drop table if exists subscribers;
