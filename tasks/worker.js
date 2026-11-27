/**
 * FIQSTUDIO Tasks: a standalone task manager web app (Worker "fiqstudio-tasks").
 *
 * Static app in ./public; this Worker runs first only for /api/*.
 * Data: D1 fiqstudio-pm-db, tables studio_clients, studio_projects, studio_tasks
 * (the same tables the dashboard used, so existing data carries over).
 *
 * Every /api/* call must carry a valid Cloudflare Access login (JWT signature, issuer and audience checked).
 * Variables (Cloudflare dashboard, kept on deploy):
 *   ACCESS_TEAM_DOMAIN -> fiqstudio.cloudflareaccess.com (set in wrangler.jsonc)
 *   ACCESS_AUD         -> the Access "AUD" tag shown when Access is enabled for this Worker
 */

let jwksCache = { expires: 0, keys: null };

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const newId = () => crypto.randomUUID();
const clean = (v, max) => { if (v == null) return null; const s = String(v).trim().slice(0, max); return s || null; };
const isDate = v => v == null || /^\d{4}-\d{2}-\d{2}$/.test(v);

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

async function body(request) {
  const text = await request.text();
  if (text.length > 20000) return null;
  try { const b = JSON.parse(text); return b && typeof b === "object" && !Array.isArray(b) ? b : null; } catch { return null; }
}

// Field rules per table: [column, validator]. A validator returns undefined to reject a value.
const enumOf = list => v => list.includes(v) ? v : undefined;
const dateField = v => (v === null || v === "") ? null : (isDate(v) ? v : undefined);
const RULES = {
  studio_tasks: {
    required: "title",
    fields: {
      title: v => clean(v, 250) || undefined,
      description: v => clean(v, 5000),
      status: enumOf(["todo", "in_progress", "blocked", "completed", "cancelled"]),
      priority: enumOf(["low", "medium", "high", "urgent"]),
      start_date: dateField, due_date: dateField,
      project_id: v => clean(v, 100), client_id: v => clean(v, 100),
      sort_order: v => Number.isInteger(v) ? v : undefined
    },
    defaults: { status: "todo", priority: "medium", sort_order: 0 }
  },
  studio_projects: {
    required: "project_name",
    fields: {
      project_name: v => clean(v, 200) || undefined,
      description: v => clean(v, 5000),
      client_id: v => clean(v, 100),
      status: enumOf(["planning", "active", "on_hold", "completed", "cancelled"]),
      priority: enumOf(["low", "medium", "high", "urgent"]),
      start_date: dateField, due_date: dateField
    },
    defaults: { status: "planning", priority: "medium" }
  },
  studio_clients: {
    required: "client_name",
    fields: {
      client_name: v => clean(v, 200) || undefined,
      business_name: v => clean(v, 200),
      client_type: enumOf(["individual", "business"]),
      email: v => clean(v, 254), phone: v => clean(v, 50),
      status: enumOf(["active", "inactive", "archived"]),
      notes: v => clean(v, 5000)
    },
    defaults: { client_type: "business", status: "active" }
  }
};
function pick(table, b, creating) {
  const rule = RULES[table], out = {};
  for (const [k, fn] of Object.entries(rule.fields)) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
    const v = fn(b[k]);
    if (v === undefined) return { error: `Invalid value for ${k}` };
    out[k] = v;
  }
  if (creating) {
    for (const [k, v] of Object.entries(rule.defaults)) if (!(k in out)) out[k] = v;
    if (!out[rule.required]) return { error: `${rule.required} is required` };
  }
  return { out };
}

const LIST_SQL = {
  studio_tasks: `SELECT t.*, p.project_name, c.client_name FROM studio_tasks t
    LEFT JOIN studio_projects p ON p.id = t.project_id
    LEFT JOIN studio_clients c ON c.id = COALESCE(t.client_id, p.client_id)
    ORDER BY CASE t.status WHEN 'in_progress' THEN 1 WHEN 'todo' THEN 2 WHEN 'blocked' THEN 3 WHEN 'completed' THEN 4 ELSE 5 END,
      CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
      t.due_date IS NULL, t.due_date, t.created_at`,
  studio_projects: `SELECT p.*, c.client_name FROM studio_projects p LEFT JOIN studio_clients c ON c.id = p.client_id ORDER BY p.created_at DESC`,
  studio_clients: `SELECT * FROM studio_clients ORDER BY client_name COLLATE NOCASE`
};
const TABLE = { tasks: "studio_tasks", projects: "studio_projects", clients: "studio_clients" };

async function api(request, env, user) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method.toUpperCase();

  if (path === "/api/me" && method === "GET") return json({ email: user.email });

  const m = path.match(/^\/api\/(tasks|projects|clients)(?:\/([^/]+))?$/);
  if (!m) return json({ error: "Not found" }, 404);
  const table = TABLE[m[1]], id = m[2] ? decodeURIComponent(m[2]) : null;

  if (method !== "GET") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "Origin not allowed" }, 403);
  }

  if (!id && method === "GET") {
    const { results } = await env.DB.prepare(LIST_SQL[table]).all();
    return json({ data: results || [] });
  }
  if (!id && method === "POST") {
    const b = await body(request);
    if (!b) return json({ error: "Invalid JSON body" }, 400);
    const { out, error } = pick(table, b, true);
    if (error) return json({ error }, 400);
    const newRowId = newId();
    const cols = ["id", ...Object.keys(out)];
    await env.DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .bind(newRowId, ...Object.values(out)).run();
    return json({ data: await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(newRowId).first() }, 201);
  }

  const existing = id ? await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first() : null;
  if (!existing) return json({ error: "Not found" }, 404);

  if (method === "PATCH") {
    const b = await body(request);
    if (!b) return json({ error: "Invalid JSON body" }, 400);
    const { out, error } = pick(table, b, false);
    if (error) return json({ error }, 400);
    const keys = Object.keys(out);
    if (!keys.length) return json({ error: "Nothing to update" }, 400);
    await env.DB.prepare(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .bind(...Object.values(out), id).run();
    if (table === "studio_tasks" && out.status && out.status !== existing.status) {
      try {
        await env.DB.prepare(`INSERT INTO task_activity_logs (id, task_id, action, old_value, new_value, details) VALUES (?, ?, 'updated', ?, ?, ?)`)
          .bind(newId(), id, existing.status, out.status, `Updated by ${user.email || "Access user"}`).run();
      } catch {}
    }
    return json({ data: await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first() });
  }

  if (method === "DELETE") {
    const stmts = [];
    if (table === "studio_tasks") {
      try {
        const { results } = await env.DB.prepare("SELECT object_key FROM task_attachments WHERE task_id = ?").bind(id).all();
        if (env.FILES) for (const f of results || []) await env.FILES.delete(f.object_key);
      } catch {}
      for (const t of ["task_attachments", "task_comments", "task_activity_logs"]) stmts.push(env.DB.prepare(`DELETE FROM ${t} WHERE task_id = ?`).bind(id));
    }
    if (table === "studio_projects") stmts.push(env.DB.prepare("UPDATE studio_tasks SET project_id = NULL WHERE project_id = ?").bind(id));
    if (table === "studio_clients") {
      stmts.push(env.DB.prepare("UPDATE studio_projects SET client_id = NULL WHERE client_id = ?").bind(id));
      stmts.push(env.DB.prepare("UPDATE studio_tasks SET client_id = NULL WHERE client_id = ?").bind(id));
    }
    stmts.push(env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id));
    await env.DB.batch(stmts);
    return json({ deleted: true });
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
      return await api(request, env, user);
    } catch {
      return json({ error: "Server error. Try again in a moment" }, 500);
    }
  }
};
