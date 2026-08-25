---
name: demo-registry
description: Check the shared demo registry before building a new demo, and add finished demos to it. Use this whenever a consultant is about to create, scope, or pitch a demo, prototype, video, or slide deck — first verify whether one already exists, and after building, register it. Triggers on requests like "I want to build a demo for X", "is there already a demo for Y", "add this demo to the registry".
---

# Demo Registry

A shared catalogue of demos, prototypes, videos and decks. Use it to avoid
rebuilding something that already exists, and to register new work so others can
find it. **Entries can be added and edited, but never deleted** — there is no
delete endpoint. Never attempt to remove one.

## Endpoints

- **Browse (human-facing site):**
  `https://demo-registry.ttcai.dev`
- **Read (no auth):** `GET https://demo-registry.jeprasher.workers.dev/demos`
  Returns `{ "version": 1, "demos": [...] }`. Retired entries are already
  filtered out server-side.
- **Write (add or edit):** POST JSON to
  `https://demo-registry.jeprasher.workers.dev`

## When a consultant wants to build a demo — ALWAYS check first

1. `GET` the read URL above.
2. Semantically compare the consultant's intent against each entry's `title`,
   `summary`, `tags`, and `type`. Match on meaning, not just keywords.
3. **If a close match exists**, stop and surface it before any building:
   > "There's already a demo that may cover this: **<title>** — <url>. Summary: <summary>. Want to reuse or adapt it instead of building new?"
   List up to 3 candidates if several are relevant.
4. **If nothing matches**, say so briefly and proceed with the consultant's request.

## Adding a demo to the registry

Only after a demo is actually built/available. Confirm the details with the
consultant, then POST:

```
POST https://demo-registry.jeprasher.workers.dev
Content-Type: application/json

{
  "title":       "Short, descriptive name",
  "type":        "demo | video | slides | prototype | other",
  "url":         "https://… (the live/clickable link; for a video, the video URL)",
  "screenshots": ["https://…/shot1.png"],
  "tags":        ["domain", "tech", "client"],
  "summary":     "1–3 sentences: what it shows and when to use it.",
  "addedBy":     "consultant name or email"
}
```

The server assigns `id` and `added` (date). On success it returns `{ "ok": true, "id": "…" }`.

### Editing an existing entry

Include the entry's `id` in the same POST body. Only `title`, `type`, `url`,
`summary`, `tags` and `screenshots` change — `id`, `added` and `addedBy` are
preserved by the server no matter what you send, and `edited` is stamped.
Use this to fix a broken link or improve a summary; confirm with the consultant
first, since edits overwrite the current values.

### Uploading screenshots

`screenshots` must be http/https image URLs. If you have local image files, upload
them first — POST each one as multipart to the `/upload` route, which commits it to
`screenshots/` in the repo and returns a hosted URL to put in `screenshots`:

```
curl -X POST https://demo-registry.jeprasher.workers.dev/upload -F "file=@shot1.png"
# → { "ok": true, "url": "https://raw.githubusercontent.com/jepras/demo-registry/main/screenshots/2026-07-03-ab12cd34.png" }
```

Limits: one file per request, ≤ 5 MB, types png/jpeg/webp/gif/svg. Then include the
returned URL(s) in the entry's `screenshots` array (max 10).

### Rules
- Required: `title`, `url` (valid http/https), `summary`. Others are optional.
- `url` and every `screenshots` entry must be valid http/https URLs.
- Never try to delete an entry — there is no delete endpoint, and it is not something to work around. If a demo is genuinely retired, tell the consultant to ask the maintainer.
- Write good `tags` and a clear `summary`: they are what future searches match against.
