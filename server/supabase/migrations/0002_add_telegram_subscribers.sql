-- ---------------------------------------------------------------------------
-- Telegram subscribers.
--
-- One row per Telegram chat that has sent /start to the bot. When a price
-- change fires, the server loops over every row here and sends that chat a
-- message. There is no per-user product list - every subscriber gets every
-- notification for the single shared product list.
-- ---------------------------------------------------------------------------
create table subscribers (
  id         bigint generated always as identity primary key,
  chat_id    text    not null unique,
  created_at text    not null
);

create index idx_subscribers_chat_id on subscribers (chat_id);
