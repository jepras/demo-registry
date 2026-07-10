# Demo registry — working notes for Claude

A searchable, append-only catalogue of demos. Reads are a static GitHub Pages
site (`index.html`) that fetches `registry.json`; writes go through a Cloudflare
Worker (`worker/`) that holds a scoped GitHub token.

## ⚠️ `registry.json` is remote-owned — do NOT overwrite it

Demos are submitted through the site's "Add a demo" form. The Worker commits
them **directly to `registry.json` on `main`** — they never pass through anyone's
local checkout. So your local copy goes stale the moment someone submits, and
pushing a stale copy would **silently revert their submission or edit**.

The CI guard (`.github/workflows/append-only.yml`) only fails on *deletions* — an
in-place revert of an edited/added entry passes CI unnoticed. Treat `registry.json`
as append-only remote state you read, not data you author.

Rules:
- **Never** hand-edit `registry.json` and push it, unless the user explicitly asks.
- **Always** `git pull` (or fetch + fast-forward) immediately before any commit
  that could include `registry.json`, so you're not carrying a stale copy.
- Prefer committing **only** the files you changed (e.g. `git add index.html`) so
  a stale `registry.json` in the working tree can't ride along.
- To feature/reorder demos, **do not** touch the data. Edit `FEATURED_IDS` in
  `index.html` — a list under our control that the Worker never writes to.

## Featuring & ordering (frontend, in `index.html`)

- Cards render most-recent-first (`added` date). Featured demos are pinned above
  that, in `FEATURED_IDS` array order, with a "★ Featured" badge.
- Pin a demo by adding its `id` (from `registry.json`) to `FEATURED_IDS`.

## Deploy

- Site: commit + push `index.html` to `main` → GitHub Pages rebuilds
  (`https://jepras.github.io/demo-registry/`). No build step.
- Worker: `cd worker && wrangler deploy` (only when `worker/` changes).
