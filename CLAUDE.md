# Demo registry — working notes for Claude

A searchable catalogue of demos. `index.html` is a static GitHub Pages site; it
reads and writes through one Cloudflare Worker (`worker/`) backed by a **D1
database**. Screenshots still live in `screenshots/` in this repo — that is the
only thing the GitHub token is used for now.

The old design kept the data in `registry.json` and committed to it via the
GitHub API. That is entirely gone: no raw.githubusercontent read path, no
append-only CI guard, no `skip-worktree` on the data file.

## The data lives in D1, not in this repo

`registry.json` is a **frozen historical snapshot** — the pre-migration data,
kept only for reference. Nothing reads it. Don't edit it, don't resurrect it.
`backup/registry.snapshot-2026-08-25.json` is the verified copy taken at
migration time.

8 of the 16 rows are live; the other 8 are soft-deleted. To look at the live data:

```bash
cd worker
wrangler d1 execute demo-registry --remote \
  --command "select id, title, added from demos where deleted_at is null order by added desc"
```

## What can and cannot change over HTTP

- **Add** — anyone past the site's password gate. `POST /` with no `id`.
- **Edit** — anyone. `POST /` with an `id`. Only title, type, url, summary, tags
  and screenshots are writable; `id`, `added` and `added_by` are never
  overwritten (the UPDATE names its columns explicitly), and `edited` is stamped.
- **Delete** — **not possible over HTTP.** No delete route, no DELETE method.

## Retiring a demo (maintainer only)

Soft delete, so it's reversible and the row is never actually gone:

```bash
wrangler d1 execute demo-registry --remote \
  --command "update demos set deleted_at = date('now') where id = '<id>'"
# restore:  ... set deleted_at = null where id = '<id>'
```

`GET /demos` filters on `deleted_at is null`. This replaced the old `HIDDEN_IDS`
array in `index.html` — don't reintroduce it.

## Frontend-only lists (in `index.html`)

These are editorial, deliberately *not* in the database, and the Worker never
touches them:

- `FEATURED_IDS` — pinned to the top of their section, in array order, with a
  "★ Featured" badge.
- `UNAVAILABLE_IDS` — links that are dead or permission-gated. The card stays
  **visible and searchable** but is dimmed, gets a "Link needs fixing" badge, and
  sorts to the bottom of its section. Remove an id once its link works again.
  This is a to-do flag, *not* a delete — for that, use `deleted_at` above.
  **Currently empty:** the 7 demos that used to sit here were retired in D1 on
  2026-08-25 instead. Keep the mechanism; it's the right tool for a link that's
  worth fixing rather than hiding.
- `OUR_FORMAT_MARKER` / `OUR_FORMAT_IDS` — splits the "Our format" section from
  "Other demos".

## Deploy

- Site: commit + push `index.html` to `main` → GitHub Pages rebuilds
  (`https://jepras.github.io/demo-registry/`, custom domain
  `https://demo-registry.ttcai.dev`). No build step.
- Worker: `cd worker && wrangler deploy` (only when `worker/` changes).
- Schema change: edit `worker/schema.sql`, apply with
  `wrangler d1 execute demo-registry --remote --file=schema.sql`.

> `wrangler` may need `env -u CLOUDFLARE_API_TOKEN` if that env var is set — the
> token in it lacks D1 permission; OAuth (`wrangler login`) has it.
