/**
 * FIQSTUDIO API Worker (DEV)
 * Bindings (set in wrangler.jsonc):
 *   env.DB    -> D1 database fiqstudio-pm-db
 *   env.FILES -> R2 bucket fiqstudio-files
 *   env.ASSETS -> static dashboard files in /public
 * Daikin proxy (Cloudflare dashboard, kept on every deploy):
 *   DAIKIN_WORKER_URL  -> Variable: https://godaikin-hub.<your-account>.workers.dev
 *   DAIKIN_API_SECRET  -> Secret: the godaikin-hub API secret
 * Fiq AI proxy (Cloudflare dashboard, kept on every deploy):
 *   FIQ_AI_URL         -> Variable: https://fiq-ai.<your-account>.workers.dev
 *   FIQ_AI_SECRET      -> Secret: the fiq-ai API_SECRET PIN
 * Token Monitor proxy (Cloudflare dashboard, kept on every deploy):
 *   TOKEN_MONITOR_URL    -> Variable: https://token-monitor-hub.<your-account>.workers.dev
 *   TOKEN_MONITOR_SECRET -> Secret: the token-monitor-hub stats secret
 * Variables to set in the Cloudflare dashboard (they are kept on every deploy):
 *   ACCESS_TEAM_DOMAIN -> your-team.cloudflareaccess.com (no https://)
 *   ACCESS_AUD         -> Cloudflare Access application AUD tag of THIS Worker
 *   APP_ORIGIN         -> the exact URL of this Worker, e.g. https://fiqstudio-dev.xxx.workers.dev
 *
 * Only /api/* runs this code first. Everything else is served from /public.
 * This Worker validates the Access JWT signature and audience.
 */

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "application/pdf",
  "text/plain", "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);

let jwksCache = { expires: 0, keys: null };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.APP_ORIGIN;
  if (!origin || !allowed || origin !== allowed) return {};
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type, CF-Access-Jwt-Assertion",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}

function withCors(response, request, env) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request, env))) h.set(k, v);
  return new Response(response.body, { status: response.status, headers: h });
}

function b64urlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function getJwks(teamDomain) {
  const now = Date.now();
  if (jwksCache.keys && jwksCache.expires > now) return jwksCache.keys;
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const response = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) throw new Error("Unable to retrieve Cloudflare Access signing keys");
  const data = await response.json();
  jwksCache = { keys: data.keys || [], expires: now + 5 * 60 * 1000 };
  return jwksCache.keys;
}

async function verifyAccess(request, env) {
  const team = (env.ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const audExpected = env.ACCESS_AUD;
  const token = request.headers.get("CF-Access-Jwt-Assertion");
  if (!team || !audExpected || !token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    if (header.alg !== "RS256" || !header.kid) return null;

    const issuer = `https://${team}`;
    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !aud.includes(audExpected) ||
        typeof claims.exp !== "number" || claims.exp <= now ||
        (claims.nbf && claims.nbf > now)) return null;

    const keys = await getJwks(team);
    const jwk = keys.find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
    );
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = b64urlToBytes(parts[2]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
    if (!valid) return null;
    return { email: claims.email || "", subject: claims.sub || "" };
  } catch {
    return null;
  }
}

function newId() {
  return crypto.randomUUID();
}

function cleanString(value, max = 5000) {
  if (value == null) return null;
  return String(value).trim().slice(0, max) || null;
}

function safeFilename(name) {
  return String(name || "file").replace(/[^\w.\-() ]/g, "_").slice(0, 140);
}

async function bodyJson(request) {
  try { return await request.json(); } catch { return null; }
}

// Server-side proxy to the GO DAIKIN hub. The hub's secret lives only in this Worker
// (env.DAIKIN_API_SECRET), so the browser never sees it. Fixed allow-list of two calls.
async function daikinProxy(request, env, path, method) {
  const base = String(env.DAIKIN_WORKER_URL || "").trim().replace(/\/+$/, "");
  if (!base || !env.DAIKIN_API_SECRET) {
    return json({ ok: false, error: "Daikin proxy is not configured" }, 503);
  }
  const headers = new Headers({ "X-API-Secret": env.DAIKIN_API_SECRET, "Accept": "application/json" });
  let target;
  let init;

  if (path === "/api/daikin/devices" && method === "GET") {
    target = `${base}/api/devices?t=${Date.now()}`;
    init = { method: "GET", headers };
  } else if (path === "/api/daikin/control" && method === "POST") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== env.APP_ORIGIN) return json({ ok: false, error: "Origin not allowed" }, 403);
    const text = await request.text();
    if (text.length > 4000) return json({ ok: false, error: "Payload too large" }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "Invalid body" }, 400);
    headers.set("Content-Type", "application/json");
    target = `${base}/api/control`;
    init = { method: "POST", headers, body: JSON.stringify(body) };
  } else {
    return null;
  }

  try {
    const res = await fetch(target, init);
    const out = await res.text();
    return new Response(out, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" }
    });
  } catch {
    return json({ ok: false, error: "Daikin hub is unreachable" }, 502);
  }
}

// Server-side proxy to the fiq-ai Worker. Its PIN lives only here (env.FIQ_AI_SECRET).
// Fixed allow-list: POST /api/ai/chat -> /api/chat, POST /api/ai/tts -> /api/tts.
async function fiqAiProxy(request, env, path, method) {
  const routes = { "/api/ai/chat": "/api/chat", "/api/ai/tts": "/api/tts" };
  const upstreamPath = routes[path];
  if (!upstreamPath || method !== "POST") return null;

  const base = String(env.FIQ_AI_URL || "").trim().replace(/\/+$/, "");
  if (!base || !env.FIQ_AI_SECRET) {
    return json({ ok: false, error: "Fiq AI proxy is not configured" }, 503);
  }
  const origin = request.headers.get("Origin");
  if (origin && origin !== env.APP_ORIGIN) return json({ ok: false, error: "Origin not allowed" }, 403);

  const text = await request.text();
  if (text.length > 64000) return json({ ok: false, error: "Payload too large" }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "Invalid body" }, 400);

  try {
    const res = await fetch(base + upstreamPath, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Secret": env.FIQ_AI_SECRET },
      body: JSON.stringify(body)
    });
    return new Response(res.body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" }
    });
  } catch {
    return json({ ok: false, error: "Fiq AI is unreachable" }, 502);
  }
}

// Server-side proxy to token-monitor-hub (replaces token_proxy.php). Its secret lives only
// here (env.TOKEN_MONITOR_SECRET). Read-only: GET /api/tokens/stats -> /api/stats.
async function tokenMonitorProxy(env, path, method) {
  if (path !== "/api/tokens/stats" || method !== "GET") return null;
  const base = String(env.TOKEN_MONITOR_URL || "").trim().replace(/\/+$/, "");
  if (!base || !env.TOKEN_MONITOR_SECRET) {
    return json({ ok: false, error: "not_configured", message: "Token Monitor proxy is not configured" }, 503);
  }
  try {
    const res = await fetch(`${base}/api/stats`, {
      method: "GET",
      headers: { "Accept": "application/json", "Authorization": `Bearer ${env.TOKEN_MONITOR_SECRET}` }
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" }
    });
  } catch {
    return json({ ok: false, error: "upstream_unreachable", message: "Could not reach Token Monitor Hub" }, 502);
  }
}

async function route(request, env, user) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (path === "/api/health" && method === "GET") {
    const row = await env.DB.prepare("SELECT 1 AS ok").first();
    return json({ ok: row?.ok === 1, service: "fiqstudio-app", database: "connected", user: user.email });
  }

  if (path === "/api/clients" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, client_name, business_name, client_type, email, phone, status, notes, created_at, updated_at
       FROM studio_clients ORDER BY client_name`
    ).all();
    return json({ data: results || [] });
  }

  if (path === "/api/clients" && method === "POST") {
    const b = await bodyJson(request);
    if (!b || !cleanString(b.client_name, 200)) return json({ error: "client_name is required" }, 400);
    const id = newId();
    await env.DB.prepare(
      `INSERT INTO studio_clients (id, client_name, business_name, client_type, email, phone, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, cleanString(b.client_name, 200), cleanString(b.business_name, 200),
      b.client_type === "business" ? "business" : "individual",
      cleanString(b.email, 254), cleanString(b.phone, 50),
      ["active", "inactive", "archived"].includes(b.status) ? b.status : "active",
      cleanString(b.notes, 5000)).run();
    return json({ id, created: true }, 201);
  }

  if (path === "/api/projects" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT p.*, c.client_name FROM studio_projects p
       LEFT JOIN studio_clients c ON c.id = p.client_id
       ORDER BY p.created_at DESC`
    ).all();
    return json({ data: results || [] });
  }

  if (path === "/api/projects" && method === "POST") {
    const b = await bodyJson(request);
    if (!b || !cleanString(b.project_name, 200)) return json({ error: "project_name is required" }, 400);
    const id = newId();
    const status = ["planning", "active", "on_hold", "completed", "cancelled"].includes(b.status) ? b.status : "planning";
    const priority = ["low", "medium", "high", "urgent"].includes(b.priority) ? b.priority : "medium";
    await env.DB.prepare(
      `INSERT INTO studio_projects (id, client_id, project_name, description, status, priority, start_date, due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, cleanString(b.client_id, 100), cleanString(b.project_name, 200),
      cleanString(b.description, 5000), status, priority,
      cleanString(b.start_date, 30), cleanString(b.due_date, 30)).run();
    return json({ id, created: true }, 201);
  }

  if (path === "/api/tasks" && method === "GET") {
    const status = url.searchParams.get("status");
    let query = `SELECT t.*, p.project_name, c.client_name
                 FROM studio_tasks t
                 LEFT JOIN studio_projects p ON p.id = t.project_id
                 LEFT JOIN studio_clients c ON c.id = t.client_id`;
    const args = [];
    if (status && ["todo", "in_progress", "blocked", "completed", "cancelled"].includes(status)) {
      query += " WHERE t.status = ?";
      args.push(status);
    }
    query += " ORDER BY CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, t.due_date";
    const stmt = env.DB.prepare(query);
    const { results } = args.length ? await stmt.bind(...args).all() : await stmt.all();
    return json({ data: results || [] });
  }

  if (path === "/api/tasks" && method === "POST") {
    const b = await bodyJson(request);
    if (!b || !cleanString(b.title, 250)) return json({ error: "title is required" }, 400);
    const id = newId();
    const status = ["todo", "in_progress", "blocked", "completed", "cancelled"].includes(b.status) ? b.status : "todo";
    const priority = ["low", "medium", "high", "urgent"].includes(b.priority) ? b.priority : "medium";
    await env.DB.prepare(
      `INSERT INTO studio_tasks (id, project_id, client_id, title, description, status, priority, start_date, due_date, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, cleanString(b.project_id, 100), cleanString(b.client_id, 100),
      cleanString(b.title, 250), cleanString(b.description, 5000), status, priority,
      cleanString(b.start_date, 30), cleanString(b.due_date, 30),
      Number.isInteger(b.sort_order) ? b.sort_order : 0).run();
    await env.DB.prepare(
      `INSERT INTO task_activity_logs (id, task_id, action, new_value, details)
       VALUES (?, ?, 'created', ?, ?)`
    ).bind(newId(), id, status, `Created by ${user.email || "Cloudflare Access user"}`).run();
    return json({ id, created: true }, 201);
  }

  const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && method === "PATCH") {
    const id = taskMatch[1];
    const b = await bodyJson(request);
    if (!b) return json({ error: "Invalid JSON body" }, 400);
    const existing = await env.DB.prepare("SELECT * FROM studio_tasks WHERE id = ?").bind(id).first();
    if (!existing) return json({ error: "Task not found" }, 404);
    const fields = [];
    const values = [];
    const allowed = {
      title: v => cleanString(v, 250),
      description: v => cleanString(v, 5000),
      status: v => ["todo", "in_progress", "blocked", "completed", "cancelled"].includes(v) ? v : undefined,
      priority: v => ["low", "medium", "high", "urgent"].includes(v) ? v : undefined,
      due_date: v => cleanString(v, 30),
      start_date: v => cleanString(v, 30),
      project_id: v => cleanString(v, 100),
      client_id: v => cleanString(v, 100)
    };
    for (const [key, validator] of Object.entries(allowed)) {
      if (Object.prototype.hasOwnProperty.call(b, key)) {
        const value = validator(b[key]);
        if (value !== undefined) { fields.push(`${key} = ?`); values.push(value); }
      }
    }
    if (!fields.length) return json({ error: "No valid fields to update" }, 400);
    fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    values.push(id);
    await env.DB.prepare(`UPDATE studio_tasks SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
    const updated = await env.DB.prepare("SELECT * FROM studio_tasks WHERE id = ?").bind(id).first();
    await env.DB.prepare(
      `INSERT INTO task_activity_logs (id, task_id, action, old_value, new_value, details)
       VALUES (?, ?, 'updated', ?, ?, ?)`
    ).bind(newId(), id, existing.status, updated.status, `Updated by ${user.email || "Cloudflare Access user"}`).run();
    return json({ data: updated });
  }

  const commentsMatch = path.match(/^\/api\/tasks\/([^/]+)\/comments$/);
  if (commentsMatch && method === "POST") {
    const taskId = commentsMatch[1];
    const b = await bodyJson(request);
    if (!b || !cleanString(b.comment, 5000)) return json({ error: "comment is required" }, 400);
    const task = await env.DB.prepare("SELECT id FROM studio_tasks WHERE id = ?").bind(taskId).first();
    if (!task) return json({ error: "Task not found" }, 404);
    const id = newId();
    await env.DB.prepare(
      "INSERT INTO task_comments (id, task_id, comment) VALUES (?, ?, ?)"
    ).bind(id, taskId, cleanString(b.comment, 5000)).run();
    return json({ id, created: true }, 201);
  }

  const uploadMatch = path.match(/^\/api\/tasks\/([^/]+)\/attachments$/);
  if (uploadMatch && method === "POST") {
    const taskId = uploadMatch[1];
    const task = await env.DB.prepare("SELECT id FROM studio_tasks WHERE id = ?").bind(taskId).first();
    if (!task) return json({ error: "Task not found" }, 404);
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file.arrayBuffer !== "function") return json({ error: "Select a file in the 'file' field" }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return json({ error: "Maximum file size is 10 MB" }, 413);
    const type = file.type || "application/octet-stream";
    if (!ALLOWED_UPLOAD_TYPES.has(type)) return json({ error: "File type is not allowed" }, 415);
    const filename = safeFilename(file.name);
    const objectKey = `tasks/${taskId}/${newId()}-${filename}`;
    await env.FILES.put(objectKey, await file.arrayBuffer(), {
      httpMetadata: { contentType: type },
      customMetadata: { originalName: filename, taskId }
    });
    const attachmentId = newId();
    try {
      await env.DB.prepare(
        `INSERT INTO task_attachments (id, task_id, file_name, object_key, content_type, file_size)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(attachmentId, taskId, filename, objectKey, type, file.size).run();
    } catch (e) {
      await env.FILES.delete(objectKey);
      throw e;
    }
    return json({ id: attachmentId, file_name: filename, file_size: file.size }, 201);
  }

  const attachmentMatch = path.match(/^\/api\/attachments\/([^/]+)$/);
  if (attachmentMatch && method === "GET") {
    const item = await env.DB.prepare(
      "SELECT file_name, object_key, content_type FROM task_attachments WHERE id = ?"
    ).bind(attachmentMatch[1]).first();
    if (!item) return json({ error: "Attachment not found" }, 404);
    const object = await env.FILES.get(item.object_key);
    if (!object) return json({ error: "Stored file not found" }, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("content-type", item.content_type || "application/octet-stream");
    headers.set("content-disposition", `attachment; filename="${safeFilename(item.file_name)}"`);
    headers.set("cache-control", "private, no-store");
    return new Response(object.body, { headers });
  }

  if (attachmentMatch && method === "DELETE") {
    const item = await env.DB.prepare(
      "SELECT object_key FROM task_attachments WHERE id = ?"
    ).bind(attachmentMatch[1]).first();
    if (!item) return json({ error: "Attachment not found" }, 404);
    await env.FILES.delete(item.object_key);
    await env.DB.prepare("DELETE FROM task_attachments WHERE id = ?").bind(attachmentMatch[1]).run();
    return json({ deleted: true });
  }

  if (path.startsWith("/api/daikin/")) {
    const proxied = await daikinProxy(request, env, path, method);
    if (proxied) return proxied;
  }

  if (path.startsWith("/api/tokens/")) {
    const proxied = await tokenMonitorProxy(env, path, method);
    if (proxied) return proxied;
  }

  if (path.startsWith("/api/ai/")) {
    const proxied = await fiqAiProxy(request, env, path, method);
    if (proxied) return proxied;
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(request.url);

      // Anything that is not /api/* is the dashboard itself (static files).
      if (!url.pathname.startsWith("/api/")) {
        if (env.ASSETS) return env.ASSETS.fetch(request);
        return withCors(json({ service: "FIQSTUDIO API", status: "ready" }), request, env);
      }

      if (!env.DB || !env.FILES) return withCors(json({ error: "D1 or R2 binding is missing" }, 503), request, env);

      const user = await verifyAccess(request, env);
      if (!user) return withCors(json({ error: "Unauthorized: valid Cloudflare Access login required" }, 401), request, env);

      const response = await route(request, env, user);
      return withCors(response, request, env);
    } catch (error) {
      // Avoid returning SQL, credentials, or internal stack details to visitors.
      return withCors(json({ error: "Internal server error" }, 500), request, env);
    }
  }
};