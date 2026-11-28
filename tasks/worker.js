/**
 * FIQSTUDIO Project Management web app (Worker "fiqstudio-task") with its own sign-in.
 *
 * Who can get in:
 *   - Owner: only through the FiqStudio Hub. The Hub (behind Cloudflare Access) signs a one-time pass
 *     (HMAC, 60 s, single use) and sends the owner to /auth/owner?t=... here. No password.
 *   - Staff: user ID + password created by the owner on the Team page. Roles: manager, staff, viewer.
 *
 * Permissions (checked here, on the server):
 *   owner   -> everything, including staff accounts (/api/users)
 *   manager -> read all; create, edit and delete clients, projects and tasks
 *   staff   -> read all; create and edit tasks
 *   viewer  -> read only
 *
 * Storage (D1 fiqstudio-pm-db, tables created on first use):
 *   pm_docs (collection, id, data, updated_at)        clients / projects / tasks as JSON documents
 *   pm_users (id, name, role, pass_hash, salt, active, failed, locked_until, created_at, updated_at)
 *   pm_sessions (token_hash, user_id, role, name, expires_at, created_at)
 *   pm_used_passes (nonce, expires_at)               prevents reuse of owner passes
 *
 * Secret (Cloudflare dashboard): TASK_HANDOFF_SECRET, the same value as in the Hub Worker.
 */

const COLLECTIONS = new Set(["clients", "projects", "tasks"]);
const ROLES = ["manager", "staff", "viewer"];
const ROLE_LABEL = { owner: "Owner", manager: "Manager", staff: "Staff", viewer: "Viewer" };
const MAX_DOC = 64 * 1024, MAX_DOCS = 5000;
const PBKDF2_ITER = 100000;
const SESSION_DAYS = { owner: 1, manager: 7, staff: 7, viewer: 7 };
const MAX_FAILS = 5, LOCK_MIN = 15;
const COOKIE = "fqt_sess";
let tablesReady = false;

const enc = new TextEncoder();
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }
});
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const now = () => Math.floor(Date.now() / 1000);
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function ensureTables(env) {
  if (tablesReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS pm_docs (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (collection, id))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS pm_users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS pm_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS pm_used_passes (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)")
  ]);
  tablesReady = true;
}

// ---------- Passwords ----------
async function hashPassword(password, saltB64) {
  const salt = saltB64 ? fromB64url(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, key, 256);
  return { hash: b64url(bits), salt: b64url(salt) };
}
const validUserId = (s) => /^[a-z0-9][a-z0-9._-]{2,31}$/.test(s);
const validPassword = (s) => typeof s === "string" && s.length >= 8 && s.length <= 128;

// ---------- Sessions ----------
function cookieHeader(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
async function createSession(env, user) {
  const token = randomToken();
  const ttl = (SESSION_DAYS[user.role] || 1) * 86400;
  await env.DB.prepare("INSERT INTO pm_sessions (token_hash, user_id, role, name, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256(token), user.id, user.role, user.name, now() + ttl, new Date().toISOString()).run();
  return cookieHeader(token, ttl);
}
function readCookie(request) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,100})`));
  return m ? m[1] : null;
}
async function currentUser(request, env) {
  const token = readCookie(request);
  if (!token) return null;
  const row = await env.DB.prepare("SELECT user_id, role, name, expires_at FROM pm_sessions WHERE token_hash = ?").bind(await sha256(token)).first();
  if (!row || row.expires_at <= now()) return null;
  if (row.role !== "owner") {
    const u = await env.DB.prepare("SELECT role, name, active FROM pm_users WHERE id = ?").bind(row.user_id).first();
    if (!u || !u.active) return null;
    return { id: row.user_id, role: u.role, name: u.name };
  }
  return { id: row.user_id, role: "owner", name: row.name };
}

// ---------- Owner pass from the Hub ----------
async function verifyOwnerPass(env, t) {
  const secret = String(env.TASK_HANDOFF_SECRET || "");
  if (secret.length < 16 || typeof t !== "string" || t.length > 600) return null;
  const [payloadB64, sig] = t.split(".");
  if (!payloadB64 || !sig) return null;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = b64url(await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64)));
  if (!safeEqual(expected, sig)) return null;
  let p;
  try { p = JSON.parse(new TextDecoder().decode(fromB64url(payloadB64))); } catch { return null; }
  if (!p || p.sub !== "owner" || typeof p.exp !== "number" || p.exp < now() || typeof p.nonce !== "string" || p.nonce.length < 16) return null;
  await env.DB.prepare("DELETE FROM pm_used_passes WHERE expires_at < ?").bind(now()).run();
  try {
    await env.DB.prepare("INSERT INTO pm_used_passes (nonce, expires_at) VALUES (?, ?)").bind(p.nonce, p.exp + 60).run();
  } catch { return null; } // already used
  return { id: "owner", role: "owner", name: String(p.name || "Fiq").slice(0, 60) };
}

async function readBody(request, max = 20000) {
  const text = await request.text();
  if (text.length > max) return null;
  try { const b = JSON.parse(text); return b && typeof b === "object" && !Array.isArray(b) ? b : null; } catch { return null; }
}
const sameOrigin = (request, url) => { const o = request.headers.get("Origin"); return !o || o === url.origin; };

// ---------- Auth routes ----------
async function auth(request, env, url, path) {
  if (path === "/auth/owner" && request.method === "GET") {
    const user = await verifyOwnerPass(env, url.searchParams.get("t") || "");
    const theme = url.searchParams.get("theme");
    const back = "/" + (theme === "dark" || theme === "light" ? "?theme=" + theme : "") + "#dashboard";
    if (!user) return new Response(null, { status: 302, headers: { location: "/?login=expired#dashboard" } });
    return new Response(null, { status: 302, headers: { location: back, "set-cookie": await createSession(env, user) } });
  }
  if (path === "/auth/login" && request.method === "POST") {
    if (!sameOrigin(request, url)) return json({ error: "Origin not allowed" }, 403);
    const b = await readBody(request, 2000);
    const id = String(b && b.userId || "").trim().toLowerCase();
    const password = String(b && b.password || "");
    const fail = () => json({ error: "Wrong user ID or password" }, 401);
    const u = validUserId(id) ? await env.DB.prepare("SELECT * FROM pm_users WHERE id = ?").bind(id).first() : null;
    if (!u) { await hashPassword(password || "x"); return fail(); } // same work as a real check
    if (u.locked_until > now()) return json({ error: `Too many attempts. Try again in ${Math.ceil((u.locked_until - now()) / 60)} minutes` }, 429);
    const { hash } = await hashPassword(password, u.salt);
    if (!safeEqual(hash, u.pass_hash)) {
      const failed = u.failed + 1;
      await env.DB.prepare("UPDATE pm_users SET failed = ?, locked_until = ? WHERE id = ?")
        .bind(failed >= MAX_FAILS ? 0 : failed, failed >= MAX_FAILS ? now() + LOCK_MIN * 60 : 0, id).run();
      return fail();
    }
    if (!u.active) return json({ error: "This account is turned off. Ask the owner" }, 403);
    await env.DB.prepare("UPDATE pm_users SET failed = 0, locked_until = 0 WHERE id = ?").bind(id).run();
    const cookie = await createSession(env, { id: u.id, role: u.role, name: u.name });
    return json({ ok: true, user: { id: u.id, name: u.name, role: u.role } }, 200, { "set-cookie": cookie });
  }
  if (path === "/auth/logout" && request.method === "POST") {
    if (!sameOrigin(request, url)) return json({ error: "Origin not allowed" }, 403);
    const token = readCookie(request);
    if (token) await env.DB.prepare("DELETE FROM pm_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
  }
  return json({ error: "Not found" }, 404);
}

// ---------- Users (owner manages staff; everyone can read names for assignment) ----------
async function users(request, env, url, path, user) {
  const m = path.match(/^\/api\/users(?:\/([a-z0-9._-]{3,32}))?$/);
  const id = m && m[1];
  if (path === "/api/users" && request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT id, name, role, active, created_at FROM pm_users ORDER BY name COLLATE NOCASE").all();
    const list = (results || []).map(r => user.role === "owner"
      ? { id: r.id, name: r.name, role: r.role, active: !!r.active, createdAt: r.created_at }
      : { id: r.id, name: r.name, role: r.role, active: !!r.active });
    return json({ data: list });
  }
  if (path === "/api/me/password" && request.method === "POST") {
    if (user.role === "owner") return json({ error: "The owner signs in through FiqStudio and has no password here" }, 400);
    const b = await readBody(request, 2000);
    const u = await env.DB.prepare("SELECT salt, pass_hash FROM pm_users WHERE id = ?").bind(user.id).first();
    const cur = await hashPassword(String(b && b.current || ""), u.salt);
    if (!safeEqual(cur.hash, u.pass_hash)) return json({ error: "Current password is wrong" }, 400);
    if (!validPassword(b.next)) return json({ error: "New password must be 8 to 128 characters" }, 400);
    const h = await hashPassword(b.next);
    await env.DB.batch([
      env.DB.prepare("UPDATE pm_users SET pass_hash = ?, salt = ?, updated_at = ? WHERE id = ?").bind(h.hash, h.salt, new Date().toISOString(), user.id),
      env.DB.prepare("DELETE FROM pm_sessions WHERE user_id = ? AND token_hash != ?").bind(user.id, await sha256(readCookie(request) || ""))
    ]);
    return json({ ok: true });
  }
  if (user.role !== "owner") return json({ error: "Only the owner can manage staff accounts" }, 403);

  if (path === "/api/users" && request.method === "POST") {
    const b = await readBody(request, 4000);
    const newId = String(b && b.id || "").trim().toLowerCase();
    const name = String(b && b.name || "").trim().slice(0, 60);
    const role = String(b && b.role || "");
    if (!validUserId(newId)) return json({ error: "User ID: 3 to 32 characters, lowercase letters, numbers, dot, dash or underscore" }, 400);
    if (newId === "owner") return json({ error: "That user ID is reserved" }, 400);
    if (!name) return json({ error: "Name is required" }, 400);
    if (!ROLES.includes(role)) return json({ error: "Choose a role" }, 400);
    if (!validPassword(b.password)) return json({ error: "Password must be 8 to 128 characters" }, 400);
    if (await env.DB.prepare("SELECT 1 FROM pm_users WHERE id = ?").bind(newId).first()) return json({ error: "That user ID is already taken" }, 409);
    const h = await hashPassword(b.password);
    const ts = new Date().toISOString();
    await env.DB.prepare("INSERT INTO pm_users (id, name, role, pass_hash, salt, active, failed, locked_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?, ?)")
      .bind(newId, name, role, h.hash, h.salt, ts, ts).run();
    return json({ ok: true, id: newId }, 201);
  }
  if (id && request.method === "PATCH") {
    const b = await readBody(request, 4000);
    const u = await env.DB.prepare("SELECT id FROM pm_users WHERE id = ?").bind(id).first();
    if (!u || !b) return json({ error: "User not found" }, 404);
    const sets = [], vals = [];
    if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 60); if (!n) return json({ error: "Name is required" }, 400); sets.push("name = ?"); vals.push(n); }
    if (b.role !== undefined) { if (!ROLES.includes(b.role)) return json({ error: "Choose a role" }, 400); sets.push("role = ?"); vals.push(b.role); }
    if (b.active !== undefined) { sets.push("active = ?"); vals.push(b.active ? 1 : 0); }
    if (b.password !== undefined) {
      if (!validPassword(b.password)) return json({ error: "Password must be 8 to 128 characters" }, 400);
      const h = await hashPassword(b.password); sets.push("pass_hash = ?", "salt = ?", "failed = 0", "locked_until = 0"); vals.push(h.hash, h.salt);
    }
    if (!sets.length) return json({ error: "Nothing to update" }, 400);
    sets.push("updated_at = ?"); vals.push(new Date().toISOString());
    const stmts = [env.DB.prepare(`UPDATE pm_users SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id)];
    if (b.password !== undefined || b.active === false || b.role !== undefined) stmts.push(env.DB.prepare("DELETE FROM pm_sessions WHERE user_id = ?").bind(id));
    await env.DB.batch(stmts);
    return json({ ok: true });
  }
  if (id && request.method === "DELETE") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pm_sessions WHERE user_id = ?").bind(id),
      env.DB.prepare("DELETE FROM pm_users WHERE id = ?").bind(id)
    ]);
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}

// ---------- Documents ----------
function canWrite(role, collection, method) {
  if (role === "owner" || role === "manager") return true;
  if (role === "staff") return collection === "tasks" && method === "PUT";
  return false;
}
async function docs(request, env, url, path, user) {
  const m = path.match(/^\/api\/docs\/([a-z]+)(?:\/([A-Za-z0-9_.~:@+-]{1,120}))?$/);
  if (!m || !COLLECTIONS.has(m[1])) return json({ error: "Not found" }, 404);
  const [, collection, id] = m;
  const method = request.method.toUpperCase();
  if (!id && method === "GET") {
    const { results } = await env.DB.prepare("SELECT id, data FROM pm_docs WHERE collection = ? ORDER BY updated_at").bind(collection).all();
    const data = [];
    for (const r of results || []) { try { data.push({ ...JSON.parse(r.data), id: r.id }); } catch {} }
    return json({ data });
  }
  if (!id || (method !== "PUT" && method !== "DELETE")) return json({ error: "Method not allowed" }, 405);
  if (!canWrite(user.role, collection, method)) return json({ error: `Your role (${ROLE_LABEL[user.role]}) cannot do this` }, 403);
  if (method === "PUT") {
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
      doc.createdBy = doc.createdBy || user.name;
    }
    doc.updatedBy = user.name;
    await env.DB.prepare(
      `INSERT INTO pm_docs (collection, id, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).bind(collection, id, JSON.stringify(doc), new Date().toISOString()).run();
    return json({ saved: true, id });
  }
  await env.DB.prepare("DELETE FROM pm_docs WHERE collection = ? AND id = ?").bind(collection, id).run();
  return json({ deleted: true, id });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const isApi = path.startsWith("/api/"), isAuth = path.startsWith("/auth/");
    if (!isApi && !isAuth) return env.ASSETS.fetch(request);
    try {
      if (!env.DB) return json({ error: "Database is not connected" }, 503);
      await ensureTables(env);
      if (isAuth) return await auth(request, env, url, path);
      const user = await currentUser(request, env);
      if (!user) return json({ error: "Please sign in" }, 401);
      if (request.method !== "GET" && !sameOrigin(request, url)) return json({ error: "Origin not allowed" }, 403);
      if (path === "/api/me" && request.method === "GET") return json({ user: { ...user, roleLabel: ROLE_LABEL[user.role] } });
      if (path === "/api/users" || path.startsWith("/api/users/") || path === "/api/me/password") return await users(request, env, url, path, user);
      if (path.startsWith("/api/docs/")) return await docs(request, env, url, path, user);
      return json({ error: "Not found" }, 404);
    } catch {
      return json({ error: "Server error. Try again in a moment" }, 500);
    }
  }
};
