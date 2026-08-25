-- Demo registry schema. Apply with:
--   wrangler d1 execute demo-registry --remote --file=schema.sql
--
-- Deletes are deliberately not reachable over HTTP: the Worker exposes no
-- DELETE route, and `deleted_at` is only ever set by a maintainer running SQL
-- directly. GET /demos filters on `deleted_at is null`, so hiding an entry is
-- reversible — the row is never actually gone.

create table if not exists demos (
  id          text primary key,
  title       text not null,
  type        text not null default 'demo',
  url         text not null,
  summary     text not null,
  tags        text not null default '[]',  -- JSON array
  screenshots text not null default '[]',  -- JSON array
  added_by    text,
  added       text not null,               -- YYYY-MM-DD, set on insert, immutable
  edited      text,                        -- YYYY-MM-DD, stamped on every edit
  deleted_at  text                         -- maintainer-only soft delete
);

-- The list endpoint's only query: live rows, newest first.
create index if not exists demos_live_added
  on demos (deleted_at, added desc);
