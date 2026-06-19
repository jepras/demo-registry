/**
 * Demo Registry — append-only write endpoint.
 *
 * The ONLY component that holds a GitHub token. Both the public form and the
 * Claude skill POST new demo entries here. This Worker reads registry.json,
 * appends the new entry, and commits it back. It structurally cannot delete or
 * modify existing entries — it only ever appends.
 *
 * Secrets (set via `wrangler secret put`):
 *   GITHUB_TOKEN  – fine-grained PAT, scoped to ONLY the registry repo,
 *                   permission: Contents = Read and write. Nothing else.
 *
 * Vars (in wrangler.toml):
 *   REPO_OWNER, REPO_NAME, REPO_BRANCH, ALLOWED_ORIGIN
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

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Invalid JSON" }, 400, cors); }

    const entry = sanitize(body);
    const err = validate(entry);
    if (err) return json({ error: err }, 400, cors);

    try {
      const result = await appendEntry(env, entry);
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
