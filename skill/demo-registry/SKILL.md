---
name: demo-registry
description: Check the shared demo registry before building a new demo, and add finished demos to it. Use this whenever a consultant is about to create, scope, or pitch a demo, prototype, video, or slide deck — first verify whether one already exists, and after building, register it. Triggers on requests like "I want to build a demo for X", "is there already a demo for Y", "add this demo to the registry".
---

# Demo Registry

A shared, append-only catalogue of demos, prototypes, videos and decks. Use it to
avoid rebuilding something that already exists, and to register new work so others
can find it. **Entries can be added but never deleted** — never attempt to remove
or rewrite existing entries.

## Endpoints

- **Read (public, no auth):**
  `https://raw.githubusercontent.com/jepras/demo-registry/main/registry.json`
- **Write (add an entry):** POST JSON to the Worker:
  `https://demo-registry.jeprasher.workers.dev`
  The Worker holds the only credential; you do not need a GitHub token.

## When a consultant wants to build a demo — ALWAYS check first

1. Fetch the registry JSON from the read URL.
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
- Never send requests that try to edit or delete existing entries — the API only appends.
- Write good `tags` and a clear `summary`: they are what future searches match against.
