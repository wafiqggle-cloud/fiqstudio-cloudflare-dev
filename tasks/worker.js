/**
 * FIQSTUDIO Project Management web app (Worker "fiqstudio-task").
 *
 * Static app in ./public; this Worker runs first only for /api/*.
 * Data: D1 fiqstudio-pm-db, table pm_docs: one JSON document per client, project or task,
 * the same shape the original claude.ai artifact stored. Created on first use.
 *
 *   GET    /api/docs/:collection        -> { data: [{ id, ...fields }] }
 *   PUT    /api/docs/:collection/:id    -> save (create or replace) one document
 *   DELETE /api/docs/:collection/:id    -> delete one document
 *   collection = clients | projects | tasks
 *
 * Every /api/* call must carry a valid Cloudflare Access login (JWT signature, issuer and audience checked).
 *   ACCESS_TEAM_DOMAIN -> fiqstudio.cloudflareaccess.com (wrangler.jsonc)
 *   ACCESS_AUD         -> the Access AUD tag of this Worker (dashboard variable)
 */

let jwksCache = { expires: 0, keys: null };
let tableReady = false;
const COLLECTIONS = new Set(["clients", "projects", "tasks"]);
const MAX_DOC = 64 * 1024;
const MAX_DOCS = 5000;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

function b64urlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
async function getJwks(team) {
  const now = Date.now();
  if (jwksCache.keys && jwksCache.expires > now) return jwksCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("Access keys unavailable");
  const data = await res.json();
  jwksCache = { keys: data.keys || [], expires: now + 5 * 60 * 1000 };
  return jwksCache.keys;
}
async function verifyAccess(request, env) {
  const team = String(env.ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const aud = String(env.ACCESS_AUD || "").trim();
  const token = request.headers.get("CF-Access-Jwt-Assertion");
  if (!team || !aud || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    if (header.alg !== "RS256" || !header.kid) return null;
    const now = Math.floor(Date.now() / 1000);
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== `https://${team}` || !auds.includes(aud) || typeof claims.exp !== "number" || claims.exp <= now || (claims.nbf && claims.nbf > now)) return null;
    const jwk = (await getJwks(team)).find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return ok ? { email: claims.email || "" } : null;
  } catch { return null; }
}

async function ensureTable(env) {
  if (tableReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS pm_docs (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (collection, id))"
  ).run();
  tableReady = true;
}

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method.toUpperCase();
  const m = path.match(/^\/api\/docs\/([a-z]+)(?:\/([A-Za-z0-9_.~:@+-]{1,120}))?$/);
  if (!m || !COLLECTIONS.has(m[1])) return json({ error: "Not found" }, 404);
  const [, collection, id] = m;
  if (method !== "GET") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "Origin not allowed" }, 403);
  }
  await ensureTable(env);

  if (!id && method === "GET") {
    const { results } = await env.DB.prepare("SELECT id, data FROM pm_docs WHERE collection = ? ORDER BY updated_at").bind(collection).all();
    const data = [];
    for (const r of results || []) { try { data.push({ ...JSON.parse(r.data), id: r.id }); } catch {} }
    return json({ data });
  }
  if (id && method === "PUT") {
    const text = await request.text();
    if (text.length > MAX_DOC) return json({ error: "This item is too large to save" }, 413);
    let doc;
    try { doc = JSON.parse(text); } catch { return json({ error: "Invalid JSON" }, 400); }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return json({ error: "Invalid document" }, 400);
    delete doc.id;
    const exists = await env.DB.prepare("SELECT 1 FROM pm_docs WHERE collection = ? AND id = ?").bind(collection, id).first();
    if (!exists) {
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM pm_docs").first();
      if (row && row.n >= MAX_DOCS) return json({ error: "Storage is full. Delete old items first" }, 507);
    }
    await env.DB.prepare(
      `INSERT INTO pm_docs (collection, id, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).bind(collection, id, JSON.stringify(doc), new Date().toISOString()).run();
    return json({ saved: true, id });
  }
  if (id && method === "DELETE") {
    await env.DB.prepare("DELETE FROM pm_docs WHERE collection = ? AND id = ?").bind(collection, id).run();
    return json({ deleted: true, id });
  }
  return json({ error: "Method not allowed" }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      if (!env.DB) return json({ error: "Database is not connected" }, 503);
      const user = await verifyAccess(request, env);
      if (!user) return json({ error: "Please sign in again (Cloudflare Access)" }, 401);
      return await api(request, env);
    } catch {
      return json({ error: "Server error. Try again in a moment" }, 500);
    }
  }
};
