/**
 * Demo Registry — read + write endpoint, backed by D1.
 *
 *   GET  /demos    — the catalogue. Public (the site's password gate is the only
 *                    thing in front of it). Returns { version, demos: [...] },
 *                    the same shape the old registry.json had, so the frontend
 *                    reads it unchanged.
 *   POST /          — no `id` in the body: append a new entry.
 *                     an `id` in the body: edit that entry's mutable fields.
 *   POST /upload    — multipart image; commits it to screenshots/ in the GitHub
 *                     repo and returns its public URL. Images stay in git — they
 *                     don't belong in SQLite.
 *
 * There is deliberately no delete route and no DELETE method. Rows are only ever
 * inserted or updated, and UPDATE names its columns explicitly so an edit cannot
 * blank a row out. Hiding an entry is a maintainer-only operation:
 *
 *   wrangler d1 execute demo-registry --remote \
 *     --command "update demos set deleted_at = date('now') where id = '<id>'"
 *
 * Because that is a soft delete, it is reversible — set deleted_at back to null.
 *
 * Bindings (wrangler.toml):
 *   DB            – D1 database
 *   REPO_OWNER, REPO_NAME, REPO_BRANCH, ALLOWED_ORIGIN, SCREENSHOT_BASE_URL
 * Secrets (wrangler secret put):
 *   GITHUB_TOKEN  – fine-grained PAT, Contents: Read and write on this repo only.
 *                   Now used *only* for screenshot commits.
 */

const GH_API = "https://api.github.com";

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (request.method === "GET") {
      if (path !== "/demos") return json({ error: "Not found" }, 404, cors);
      try {
        return json({ version: 1, demos: await listDemos(env) }, 200, cors);
      } catch (e) {
        return json({ error: e.message || "Read failed" }, 500, cors);
      }
    }

    if (request.method !== "POST")
      return json({ error: "Use GET /demos or POST /" }, 405, cors);

    if (path === "/upload") {
      try {
        const result = await handleUpload(request, env);
        return json({ ok: true, url: result.url }, 200, cors);
      } catch (e) {
        return json({ error: e.message || "Upload failed" }, e.status || 500, cors);
      }
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Invalid JSON" }, 400, cors); }

    const entry = sanitize(body);
    const err = validate(entry);
    if (err) return json({ error: err }, 400, cors);

    // An `id` in the body means "edit this existing entry"; no `id` means append.
    const editId = typeof body.id === "string" ? body.id.trim() : "";

    try {
      const result = editId
        ? await updateEntry(env, editId, entry)
        : await appendEntry(env, entry);
      return json({ ok: true, id: result.id }, 200, cors);
    } catch (e) {
      return json({ error: e.message || "Server error" }, e.status || 500, cors);
    }
  }
};

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function sanitize(b) {
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const arr = (v, max) => Array.isArray(v) ? v.map(x => str(x, 500)).filter(Boolean).slice(0, max) : [];
  return {
    title: str(b.title, 200),
    type: str(b.type, 40) || "demo",
    url: str(b.url, 1000),
    screenshots: arr(b.screenshots, 10),
    tags: arr(b.tags, 20),
    summary: str(b.summary, 2000),
    addedBy: str(b.addedBy, 200)
  };
}

function validate(e) {
  if (!e.title) return "title is required";
  if (!e.url || !/^https?:\/\//i.test(e.url)) return "url must be a valid http(s) URL";
  if (!e.summary) return "summary is required";
  for (const s of e.screenshots)
    if (!/^https?:\/\//i.test(s)) return "each screenshot must be a valid http(s) URL";
  return null;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Rows store tags/screenshots as JSON text; the API speaks arrays.
function rowToEntry(r) {
  const parse = v => { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } };
  const e = {
    id: r.id,
    title: r.title,
    type: r.type,
    url: r.url,
    screenshots: parse(r.screenshots),
    tags: parse(r.tags),
    summary: r.summary,
    addedBy: r.added_by || "",
    added: r.added
  };
  if (r.edited) e.edited = r.edited;
  return e;
}

// ── Read ───────────────────────────────────────────────────────────────────

async function listDemos(env) {
  const { results } = await env.DB.prepare(
    `select id, title, type, url, summary, tags, screenshots, added_by, added, edited
       from demos
      where deleted_at is null
      order by added desc, id desc`
  ).all();
  return (results || []).map(rowToEntry);
}

// ── Write ──────────────────────────────────────────────────────────────────

// Append only. `id` is derived from date + title; on collision we suffix and
// retry rather than overwriting whatever is already sitting on that id.
async function appendEntry(env, entry) {
  const date = today();
  const baseId = `${date}-${slugify(entry.title)}` || date;

  for (let n = 1; n <= 20; n++) {
    const id = n === 1 ? baseId : `${baseId}-${n}`;
    const res = await env.DB.prepare(
      `insert into demos
         (id, title, type, url, summary, tags, screenshots, added_by, added)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do nothing`
    ).bind(
      id, entry.title, entry.type, entry.url, entry.summary,
      JSON.stringify(entry.tags), JSON.stringify(entry.screenshots),
      entry.addedBy || null, date
    ).run();

    // `do nothing` means the id was taken — try the next suffix.
    if (res.meta.changes > 0) return { id };
  }
  throw httpError("Could not allocate an id — try a slightly different title", 409);
}

// Edit one existing entry in place. Only mutable fields are named, so id, added
// and added_by survive untouched and nothing can be blanked out. A soft-deleted
// row is not editable (and stays hidden) until a maintainer restores it.
async function updateEntry(env, id, entry) {
  const res = await env.DB.prepare(
    `update demos
        set title = ?, type = ?, url = ?, summary = ?,
            tags = ?, screenshots = ?, edited = ?
      where id = ? and deleted_at is null`
  ).bind(
    entry.title, entry.type, entry.url, entry.summary,
    JSON.stringify(entry.tags), JSON.stringify(entry.screenshots), today(),
    id
  ).run();

  if (res.meta.changes === 0) throw httpError("Entry not found", 404);
  return { id };
}

// ── Screenshot uploads (still git-backed) ──────────────────────────────────

const IMG_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg"
};
const MAX_IMG_BYTES = 5 * 1024 * 1024; // 5 MB

async function handleUpload(request, env) {
  let form;
  try { form = await request.formData(); }
  catch { throw httpError("Expected multipart/form-data with a `file` field", 400); }

  const file = form.get("file");
  if (!file || typeof file === "string") throw httpError("Missing `file` field", 400);

  const ext = IMG_EXT[file.type];
  if (!ext) throw httpError(`Unsupported image type: ${file.type || "unknown"}`, 415);

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) throw httpError("Empty file", 400);
  if (bytes.length > MAX_IMG_BYTES) throw httpError("Image exceeds 5 MB", 413);

  const name = `${today()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  await commitFile(env, `screenshots/${name}`, base64(bytes), `Add screenshot: ${name}`);

  const baseUrl = (env.SCREENSHOT_BASE_URL ||
    `https://raw.githubusercontent.com/${env.REPO_OWNER}/${env.REPO_NAME}/${env.REPO_BRANCH || "main"}/screenshots`
  ).replace(/\/+$/, "");
  return { url: `${baseUrl}/${name}` };
}

// Create a brand-new file (no sha → GitHub rejects if the path already exists,
// which our unique names avoid). Auto-creates the screenshots/ folder.
async function commitFile(env, path, contentB64, message) {
  const { REPO_OWNER, REPO_NAME, GITHUB_TOKEN } = env;
  const branch = env.REPO_BRANCH || "main";
  const res = await fetch(`${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "demo-registry-worker",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({ message, content: contentB64, branch })
  });
  if (!res.ok) throw httpError(`Screenshot commit failed: ${res.status}`, 502);
}

// Base64-encode bytes in chunks (avoids blowing the call stack on large files).
function base64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
