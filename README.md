# Demo Registry

A simple public catalogue of demos, prototypes, videos and decks.

- **Reads and writes** both go through one small Cloudflare Worker backed by a **D1** database. The static GitHub Pages site (`index.html`) fetches `GET /demos`.
- **Anyone can add or edit** an entry — no GitHub account, no login beyond the site's password gate. Both the web form and the Claude skill use the same endpoint.
- **Nothing can be deleted over HTTP.** There is no delete route and no `DELETE` method, and edits name their columns explicitly so a row can't be blanked out. Retiring an entry is a maintainer-only soft delete (`deleted_at`), which is reversible.

```
Public form ─┐
             ├─► Cloudflare Worker ─► D1 (add / edit only, never delete)
Claude skill ┘         │
                       └────────────► GitHub API ─► screenshots/ (images only)

GitHub Pages / Claude skill ── GET /demos ──► Worker ─► D1
```

## Files

| File | Purpose |
|---|---|
| `worker/schema.sql` | The D1 schema — the actual database |
| `worker/seed.sql` | One-time migration seed (16 entries from `registry.json`) |
| `backup/` | Verified pre-migration snapshot (JSON + CSV) |
| `registry.json` | **Frozen** pre-migration snapshot. Nothing reads it. |
| `index.html` | GitHub Pages site: searchable cards + an "Add a demo" form |
| `worker/worker.js` | Cloudflare Worker: the append-only write endpoint |
| `worker/wrangler.toml` | Worker config (D1 binding, repo, allowed origin) |
| `skill/demo-registry/SKILL.md` | Claude skill: check-before-build + add |

## Setup

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

### 3. Create a scoped token (NOT your personal token)
GitHub → **Settings → Developer settings → Fine-grained tokens → Generate**:
- **Repository access:** Only select repositories → `demo-registry`
- **Permissions:** Repository permissions → **Contents: Read and write** (nothing else)
- Set an expiry; rotate before it lapses.

This token is now only used to commit **screenshots**. Worst case if it leaks: an attacker can add image files to this one public repo. The catalogue itself is in D1 and out of reach.

### 4. Deploy the Worker
```bash
cd worker
npm install -g wrangler          # if needed
wrangler login
# edit wrangler.toml: REPO_OWNER, REPO_NAME, ALLOWED_ORIGIN
wrangler secret put GITHUB_TOKEN # paste the fine-grained PAT
wrangler deploy
```
Copy the deployed URL (e.g. `https://demo-registry.<you>.workers.dev`).

### 5. Wire the URLs
- In `index.html`, set `WORKER_URL` to the deployed Worker URL (`REGISTRY_URL` derives from it).
- In `skill/demo-registry/SKILL.md`, replace `<your-subdomain>` in the Worker URL.
- Commit and push.

### 6. Install the skill
Copy `skill/demo-registry/` into your Claude skills directory (zip it the same way as your other skills if uploading).

## Adding, editing & retiring demos
- **Add — anyone:** open the site → **+ Add a demo** → fill the form.
- **Edit — anyone:** each card has an **Edit** link. `id`, `added` and `addedBy` are preserved; `edited` is stamped.
- **Via Claude:** the skill checks the registry before building, then POSTs new demos.
- **Retire — maintainer only**, and reversible:
  ```bash
  cd worker
  wrangler d1 execute demo-registry --remote \
    --command "update demos set deleted_at = date('now') where id = '<id>'"
  ```
  `GET /demos` hides those rows. Set `deleted_at = null` to bring one back.

> Two frontend-only lists in `index.html` are *not* in the database: `FEATURED_IDS`
> (pins a card to the top) and `UNAVAILABLE_IDS` (dims a card and badges it
> "Link needs fixing" — the demo stays visible; it's a to-do, not a delete).

## Entry shape
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
