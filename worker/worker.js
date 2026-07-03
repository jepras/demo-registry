/**
 * Demo Registry — write endpoint.
 *
 * The ONLY component that holds a GitHub token. Both the public form and the
 * Claude skill POST demo entries here. This Worker reads registry.json, applies
 * the change, and commits it back.
 *
 *   ADD  (no `id` in the body)  — open to anyone; only ever appends a new entry,
 *                                 never touches existing ones.
 *   EDIT (an `id` in the body)  — updates one existing entry's mutable fields.
 *                                 Never deletes and never changes id / added /
 *                                 addedBy. Open, like adds (no auth).
 *   UPLOAD (POST /upload)       — multipart/form-data with a `file` image field;
 *                                 commits it to screenshots/ and returns its raw
 *                                 URL to drop into an entry's `screenshots` array.
 *
 * Secrets (set via `wrangler secret put`):
 *   GITHUB_TOKEN  – fine-grained PAT, scoped to ONLY the registry repo,
 *                   permission: Contents = Read and write. Nothing else.
 *
 * Vars (in wrangler.toml):
 *   REPO_OWNER, REPO_NAME, REPO_BRANCH, ALLOWED_ORIGIN
 *   SCREENSHOT_BASE_URL – optional. Public base URL for committed screenshots.
 *                         Defaults to the repo's raw.githubusercontent path.
 */

const GH_API = "https://api.github.com";
const FILE_PATH = "registry.json";
const MAX_RETRIES = 3; // handle concurrent-write SHA conflicts

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST")
      return json({ error: "Use POST" }, 405, cors);

    // Image upload path — commits the file to screenshots/ and returns its URL.
    // The returned URL is what callers put in an entry's `screenshots` array.
    if (new URL(request.url).pathname.replace(/\/+$/, "").endsWith("/upload")) {
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
      return json({ error: e.message || "Server error" }, 500, cors);
    }
  }
};

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
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

async function appendEntry(env, entry) {
  const { REPO_OWNER, REPO_NAME, GITHUB_TOKEN } = env;
  const branch = env.REPO_BRANCH || "main";
  const base = `${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`;
  const headers = {
    "Authorization": `Bearer ${GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "demo-registry-worker",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  const today = new Date().toISOString().slice(0, 10);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // 1. Read current file (+ its sha)
    const getRes = await fetch(`${base}?ref=${branch}`, { headers });
    if (!getRes.ok) throw new Error(`Read failed: ${getRes.status}`);
    const file = await getRes.json();
    const current = JSON.parse(atob(file.content.replace(/\n/g, "")));
    const demos = current.demos || [];

    // 2. Build the new entry (id derived from date + title; deduped)
    let id = `${today}-${slugify(entry.title)}`;
    if (demos.some(d => d.id === id)) id = `${id}-${demos.length + 1}`;
    const newEntry = { id, ...entry, added: today };

    // 3. Append only
    const updated = { ...current, demos: [...demos, newEntry] };
    const content = btoa(JSON.stringify(updated, null, 2) + "\n");

    // 4. Commit with the sha we just read (optimistic concurrency)
    const putRes = await fetch(base, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `Add demo: ${entry.title}`,
        content,
        sha: file.sha,
        branch
      })
    });

    if (putRes.ok) return { id };
    if (putRes.status === 409) continue; // someone else wrote; retry with fresh sha
    throw new Error(`Write failed: ${putRes.status}`);
  }
  throw new Error("Write conflict, please retry");
}

// Update one existing entry in place. Only the mutable fields change; id, added
// and addedBy are preserved, and an `edited` date is stamped. Never deletes.
async function updateEntry(env, id, entry) {
  const { REPO_OWNER, REPO_NAME, GITHUB_TOKEN } = env;
  const branch = env.REPO_BRANCH || "main";
  const base = `${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`;
  const headers = {
    "Authorization": `Bearer ${GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "demo-registry-worker",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  const today = new Date().toISOString().slice(0, 10);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // 1. Read current file (+ its sha)
    const getRes = await fetch(`${base}?ref=${branch}`, { headers });
    if (!getRes.ok) throw new Error(`Read failed: ${getRes.status}`);
    const file = await getRes.json();
    const current = JSON.parse(atob(file.content.replace(/\n/g, "")));
    const demos = current.demos || [];

    // 2. Locate the entry and merge only the mutable fields onto it
    const i = demos.findIndex(d => d.id === id);
    if (i === -1) throw new Error("Entry not found");
    const merged = {
      ...demos[i],
      title: entry.title,
      type: entry.type,
      url: entry.url,
      screenshots: entry.screenshots,
      tags: entry.tags,
      summary: entry.summary,
      edited: today
    };

    // 3. Replace in place (same length — nothing added or removed)
    const nextDemos = demos.slice();
    nextDemos[i] = merged;
    const updated = { ...current, demos: nextDemos };
    const content = btoa(JSON.stringify(updated, null, 2) + "\n");

    // 4. Commit with the sha we just read (optimistic concurrency)
    const putRes = await fetch(base, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `Edit demo: ${entry.title}`,
        content,
        sha: file.sha,
        branch
      })
    });

    if (putRes.ok) return { id };
    if (putRes.status === 409) continue; // someone else wrote; retry with fresh sha
    throw new Error(`Write failed: ${putRes.status}`);
  }
  throw new Error("Write conflict, please retry");
}

// ── Screenshot uploads ─────────────────────────────────────────────────────
// Accepts a single image via multipart/form-data (`file` field), commits it to
// screenshots/ in the repo, and returns its public raw URL. Like adds, this is
// append-only in spirit: it only ever creates new files with unique names.

const IMG_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg"
};
const MAX_IMG_BYTES = 5 * 1024 * 1024; // 5 MB

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

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

  const today = new Date().toISOString().slice(0, 10);
  const name = `${today}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
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
