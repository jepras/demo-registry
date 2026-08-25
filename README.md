# Demo Registry

A simple public catalogue of demos, prototypes, videos and decks.

- **Reads and writes** both go through one small Cloudflare Worker backed by a **D1** database. The static GitHub Pages site (`index.html`) fetches `GET /demos`.
- **Anyone can add or edit** an entry — no GitHub account, no login beyond the site's password gate.
- **Nothing can be deleted over HTTP.** There is no delete route and no `DELETE` method, and edits name their columns explicitly so a row can't be blanked out or have its `id`/`added`/`addedBy` overwritten. Retiring an entry is a maintainer-only soft delete (`deleted_at`), which is reversible.

```
Browser ──── GET /demos ────► Worker ──► D1  (the catalogue)
        └─── POST /     ────►   │           add + edit only, never delete
                                │
             POST /upload ──────┴──► GitHub API ──► screenshots/  (images only)
```

The GitHub API is only in the picture for screenshot uploads. The catalogue data
never touches the repo.

## Files

| File | Purpose |
|---|---|
| `worker/worker.js` | The Worker: `GET /demos`, add/edit, screenshot upload |
| `worker/schema.sql` | The D1 schema — the actual database |
| `worker/wrangler.toml` | Worker config (D1 binding, repo, allowed origin) |
| `index.html` | GitHub Pages site: searchable cards + add/edit form |
| `worker/seed.sql` | One-time migration seed. Historical; already applied. |
| `backup/` | Verified pre-migration snapshot (JSON + CSV) |
| `registry.json` | **Frozen** pre-migration snapshot. Nothing reads it. |

## Setup

Only needed to stand this up from scratch — it is already deployed.

### 1. Create the repo & enable Pages
1. Create a **public** repo `jepras/demo-registry` and push these files.
2. Repo → **Settings → Pages** → Source: `main` / root. Your site:
   `https://jepras.github.io/demo-registry/`, also served at the custom domain
   `https://demo-registry.ttcai.dev` (DNS CNAME lives in the `ttcai.dev` Azure
   DNS zone; the custom domain + HTTPS enforcement is set in Pages settings).

### 2. Create the database
```bash
cd worker
wrangler d1 create demo-registry
# paste the returned database_id into wrangler.toml
wrangler d1 execute demo-registry --remote --file=schema.sql
```

### 3. Create a scoped GitHub token — for screenshots only
The catalogue lives in D1; this token exists purely so `POST /upload` can commit
images to `screenshots/`.

GitHub → **Settings → Developer settings → Fine-grained tokens → Generate**:
- **Repository access:** Only select repositories → `demo-registry`
- **Permissions:** Repository permissions → **Contents: Read and write** (nothing else)
- Set an expiry; rotate before it lapses.

Worst case if it leaks: an attacker can add image files to this one public repo.
The catalogue itself is in D1 and out of reach.

### 4. Deploy the Worker
```bash
cd worker
npm install -g wrangler          # if needed
wrangler login
# edit wrangler.toml: database_id, REPO_OWNER, REPO_NAME, ALLOWED_ORIGIN
wrangler secret put GITHUB_TOKEN # paste the fine-grained PAT
wrangler deploy
```
Copy the deployed URL (e.g. `https://demo-registry.<you>.workers.dev`).

### 5. Wire the URL
- In `index.html`, set `WORKER_URL` to the deployed Worker URL (`REGISTRY_URL`
  derives from it). Commit and push.

## Adding, editing & retiring demos

- **Add — anyone:** open the site → **+ Add a demo** → fill the form.
- **Edit — anyone:** each card has an **Edit** link. `id`, `added` and `addedBy`
  are preserved by the server regardless of what's submitted; `edited` is stamped.
- **Retire — maintainer only**, and reversible:
  ```bash
  cd worker
  wrangler d1 execute demo-registry --remote \
    --command "update demos set deleted_at = date('now') where id = '<id>'"
  ```
  `GET /demos` hides those rows. Set `deleted_at = null` to bring one back.

Inspect the live data:
```bash
cd worker
wrangler d1 execute demo-registry --remote \
  --command "select id, title, added from demos where deleted_at is null order by added desc"
```

> `wrangler` may need `env -u CLOUDFLARE_API_TOKEN` if that env var is set — the
> token in it lacks D1 permission; OAuth (`wrangler login`) has it.

> Two frontend-only lists in `index.html` are *not* in the database:
> `FEATURED_IDS` (pins a card to the top) and `UNAVAILABLE_IDS` (dims a card and
> badges it "Link needs fixing" — the demo stays visible; it's a to-do, not a
> delete). `UNAVAILABLE_IDS` is currently empty.

## Entry shape

What `GET /demos` returns and what a POST accepts. In D1, `tags` and
`screenshots` are stored as JSON text columns; the API speaks arrays.

```json
{
  "id": "2026-06-19-my-demo",   // assigned by the server
  "title": "...",
  "type": "demo | video | slides | prototype | other",
  "url": "https://…",
  "screenshots": ["https://…"],
  "tags": ["..."],
  "summary": "...",
  "added": "2026-06-19",         // assigned by the server
  "addedBy": "you@example.com"
}
```

Limits enforced by the Worker: `title` 200 chars, `summary` 2000, `url` 1000,
max 20 tags, max 10 screenshots, uploads ≤ 5 MB (png/jpeg/webp/gif/svg).
Required: `title`, `url` (http/https), `summary`.
