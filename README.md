# Demo Registry

A simple, **append-only** public catalogue of demos, prototypes, videos and decks.

- **Reads** are a static GitHub Pages site (`index.html`) that fetches `registry.json`. Free, no backend.
- **Writes** (adding or editing a demo) go through one tiny Cloudflare Worker that holds the only credential. Both the web form and the Claude skill use it. No GitHub account needed to submit.
- **Nothing can be deleted:** the Worker only appends new entries or edits existing ones in place — it never removes them. A CI check rejects any removal, and git history preserves every version.

```
Public form ─┐
             ├─► Cloudflare Worker ─► GitHub API ─► registry.json (append-only)
Claude skill ┘        (holds token)

GitHub Pages / Claude skill ── fetch ──► registry.json   (read, no auth)
```

## Files

| File | Purpose |
|---|---|
| `registry.json` | The "database" — a list of demo entries |
| `index.html` | GitHub Pages site: searchable cards + an "Add a demo" form |
| `worker/worker.js` | Cloudflare Worker: the append-only write endpoint |
| `worker/wrangler.toml` | Worker config (repo, branch, allowed origin) |
| `.github/workflows/append-only.yml` | CI: fails if any entry is removed (edits allowed) |
| `skill/demo-registry/SKILL.md` | Claude skill: check-before-build + add |

## Setup

### 1. Create the repo & enable Pages
1. Create a **public** repo `jepras/demo-registry` and push these files.
2. Repo → **Settings → Pages** → Source: `main` / root. Your site:
   `https://jepras.github.io/demo-registry/`.

### 2. Create a scoped token (NOT your personal token)
GitHub → **Settings → Developer settings → Fine-grained tokens → Generate**:
- **Repository access:** Only select repositories → `demo-registry`
- **Permissions:** Repository permissions → **Contents: Read and write** (nothing else)
- Set an expiry; rotate before it lapses.

Worst case if it leaks: an attacker can only *append* to this one public repo — they cannot delete anything (CI + git history block that) or touch your other repos.

### 3. Deploy the Worker
```bash
cd worker
npm install -g wrangler          # if needed
wrangler login
# edit wrangler.toml: REPO_OWNER, REPO_NAME, ALLOWED_ORIGIN
wrangler secret put GITHUB_TOKEN # paste the fine-grained PAT
wrangler deploy
```
Copy the deployed URL (e.g. `https://demo-registry.<you>.workers.dev`).

### 4. Wire the URLs
- In `index.html`, set `WORKER_URL` to the deployed Worker URL (and confirm `REGISTRY_URL`).
- In `skill/demo-registry/SKILL.md`, replace `<your-subdomain>` in the Worker URL.
- Commit and push.

### 5. Install the skill
Copy `skill/demo-registry/` into your Claude skills directory (zip it the same way as your other skills if uploading).

## Adding & editing demos
- **Add — anyone:** open the Pages site → **+ Add a demo** → fill the form.
- **Edit — anyone:** each card has an **Edit** link → change fields → **Save changes**.
- **Via Claude:** the skill checks the registry before building and POSTs new demos to the Worker.

> ⚠️ **Maintainers: never edit or `git add` `registry.json` locally.** The Worker is
> the sole writer — it commits adds/edits straight to `main`, so your local copy
> goes stale the moment anyone uses the UI. Pushing a stale copy would revert
> entries added since (the CI guard flags removals, but the push already landed).
> After a fresh clone, re-apply the local safeguard so Git ignores your working
> copy of the data file:
>
> ```bash
> git update-index --skip-worktree registry.json
> ```
>
> Push `index.html`, `worker/*`, and workflow changes freely — just leave the data
> file to the Worker.

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
