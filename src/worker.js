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

// Dashboard settings sync (replaces settings_sync.php). One JSON document in D1, behind Access.
// Secrets typed into the browser are stripped before saving; the Worker holds the real ones.
let settingsTableReady = false;
function stripSettingsSecrets(state) {
  const s = state.settings && typeof state.settings === "object" ? state.settings : null;
  if (s) {
    if (s.smartDevices && typeof s.smartDevices === "object") { s.smartDevices.workerSecret = ""; s.smartDevices.haToken = ""; }
    if (s.tokenMonitor && typeof s.tokenMonitor === "object") s.tokenMonitor.publicUrl = "";
    delete s.fiqAiSecret;
    delete s.googleDrive;
  }
  delete state.chat;
  return state;
}
async function settingsSync(request, env, method) {
  if (!settingsTableReady) {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS app_settings (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)"
    ).run();
    settingsTableReady = true;
  }
  if (method === "GET") {
    const row = await env.DB.prepare("SELECT data, updated_at FROM app_settings WHERE id = 'dashboard'").first();
    let data = null;
    if (row) { try { data = JSON.parse(row.data); } catch { data = null; } }
    return json({ status: "ok", exists: !!data, data, updatedAt: row ? row.updated_at : null });
  }
  if (method === "POST") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== env.APP_ORIGIN) return json({ status: "error", error: "Origin not allowed" }, 403);
    const text = await request.text();
    if (text.length > 1024 * 1024) return json({ status: "error", error: "Settings are larger than 1 MB" }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ status: "error", error: "Invalid JSON" }, 400); }
    if (!body || typeof body !== "object" || !Array.isArray(body.websites) || !Array.isArray(body.cameras)) {
      return json({ status: "error", error: "Not a FiqStudio settings object" }, 400);
    }
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO app_settings (id, data, updated_at) VALUES ('dashboard', ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).bind(JSON.stringify(stripSettingsSecrets(body)), now).run();
    return json({ status: "ok", updatedAt: now });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Client website logs (replaces order_webhook.php + orders_log.json + reports_log.json).
// Client sites ADD entries through the separate public Worker in hook/ (fiqstudio-hook).
// Here, behind Access, the dashboard reads and manages them: /api/web/*.
// ---------------------------------------------------------------------------
let webTablesReady = false;
const WEB_KEEP = 500;
async function ensureWebTables(env) {
  if (webTablesReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS web_orders (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS web_reports (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL)")
  ]);
  webTablesReady = true;
}
const clip = (v, max, dflt = "") => { const s = String(v ?? "").trim().slice(0, max); return s || dflt; };
async function webLogs(request, env, path, method) {
  await ensureWebTables(env);
  const list = async table => {
    const { results } = await env.DB.prepare(`SELECT data FROM ${table} ORDER BY created_at DESC LIMIT ${WEB_KEEP}`).all();
    return (results || []).map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
  };
  if (path === "/api/web/orders" && method === "GET") return json(await list("web_orders"));
  if (path === "/api/web/reports" && method === "GET") return json(await list("web_reports"));
  if (path === "/api/web/action" && method === "POST") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== env.APP_ORIGIN) return json({ status: "error", error: "Origin not allowed" }, 403);
    const b = await bodyJson(request);
    if (!b || typeof b !== "object") return json({ status: "error", error: "Invalid JSON" }, 400);
    const id = clip(b.id, 120);
    const update = async (table, field, value) => {
      const row = await env.DB.prepare(`SELECT data FROM ${table} WHERE id = ?`).bind(id).first();
      if (!row) return json({ status: "error", error: "Not found" }, 404);
      const d = JSON.parse(row.data); d[field] = value;
      await env.DB.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).bind(JSON.stringify(d), id).run();
      return json({ status: "updated", id });
    };
    switch (b.action) {
      case "resolve_report": return update("web_reports", "status", b.status === "Open" ? "Open" : "Resolved");
      case "delete_report": await env.DB.prepare("DELETE FROM web_reports WHERE id = ?").bind(id).run(); return json({ status: "deleted", id });
      case "update_stage": return update("web_orders", "stage", clip(b.stage, 60, "Clicked Order Now"));
      case "delete": await env.DB.prepare("DELETE FROM web_orders WHERE id = ?").bind(id).run(); return json({ status: "deleted", id });
      case "clear_all": await env.DB.prepare("DELETE FROM web_orders").run(); return json({ status: "cleared" });
      default: return json({ status: "error", error: "Unknown action" }, 400);
    }
  }
  return null;
}

// ---------- Prayer times (JAKIM zones) + azan audio ----------
const PRAYER_KEYS = ["imsak", "fajr", "syuruk", "dhuhr", "asr", "maghrib", "isha"];
const AZAN_KEY = "settings/azan-audio";
const klParts = (ms) => {
  const d = new Date(ms + 8 * 3600e3);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate() };
};
const ymd = (p) => `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;

async function cachedJson(url, ttl) {
  const cache = caches.default;
  const key = new Request(url);
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "fiqstudio-hub" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("upstream " + res.status);
  const data = await res.json();
  await cache.put(key, new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + ttl } }));
  return data;
}

async function monthFromWaktuSolat(zone, y, m) {
  const d = await cachedJson(`https://api.waktusolat.app/v2/solat/${zone}?year=${y}&month=${m}`, 21600);
  if (!d || !Array.isArray(d.prayers) || !d.prayers.length) throw new Error("empty");
  return d.prayers.map((p) => {
    const times = {};
    for (const k of PRAYER_KEYS) times[k] = Number(p[k]) || null;
    return { date: ymd({ y, m, day: p.day }), hijri: p.hijri || "", times };
  });
}

async function weekFromEsolat(zone) {
  const d = await cachedJson(`https://www.e-solat.gov.my/index.php?r=esolatApi/TakwimSolat&period=week&zone=${zone}`, 21600);
  const mon = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  return (d.prayerTime || []).map((p) => {
    const [dd, mm, yy] = String(p.date).split("-");
    const date = ymd({ y: +yy, m: mon[mm], day: +dd });
    const times = {};
    for (const k of PRAYER_KEYS) times[k] = p[k] ? Math.floor(Date.parse(`${date}T${p[k]}+08:00`) / 1000) : null;
    return { date, hijri: p.hijri || "", times };
  });
}

async function prayerRoute(request, env, path, method, url) {
  if (path === "/api/prayer" && method === "GET") {
    const zone = String(url.searchParams.get("zone") || "KTN01").toUpperCase();
    if (!/^[A-Z]{3}\d{2}$/.test(zone)) return json({ error: "Unknown zone" }, 400);
    const now = Date.now();
    const today = klParts(now), tomorrow = klParts(now + 86400e3);
    const want = [ymd(today), ymd(tomorrow)];
    let days = [], source = "JAKIM (waktusolat.app)";
    try {
      days = await monthFromWaktuSolat(zone, today.y, today.m);
      if (tomorrow.m !== today.m) days = days.concat(await monthFromWaktuSolat(zone, tomorrow.y, tomorrow.m));
    } catch {
      try { days = await weekFromEsolat(zone); source = "JAKIM e-solat"; }
      catch { return json({ error: "Prayer times are not available right now" }, 502); }
    }
    days = days.filter((d) => want.includes(d.date));
    if (!days.length) return json({ error: "Prayer times are not available right now" }, 502);
    return json({ zone, source, days }, 200, { "cache-control": "private, max-age=600" });
  }

  if (path === "/api/prayer/zones" && method === "GET") {
    try {
      const list = await cachedJson("https://api.waktusolat.app/zones", 604800);
      return json({ data: (list || []).map((z) => ({ code: z.jakimCode, state: z.negeri, area: z.daerah })) });
    } catch { return json({ error: "Zone list is not available right now" }, 502); }
  }

  if (path === "/api/prayer/locate" && method === "GET") {
    const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
    if (!(lat >= 0 && lat <= 8 && lon >= 99 && lon <= 120)) return json({ error: "That location is outside Malaysia" }, 400);
    try {
      const r = await fetch(`https://api.waktusolat.app/zones/${lat.toFixed(4)}/${lon.toFixed(4)}`, { signal: AbortSignal.timeout(8000) });
      const z = await r.json();
      if (!z || !z.zone) return json({ error: "No prayer zone found for this location" }, 404);
      return json({ zone: z.zone, area: z.district || "", state: z.state || "" });
    } catch { return json({ error: "Could not look up the location right now" }, 502); }
  }

  if (path === "/api/prayer/azan") {
    if (method === "GET") {
      const obj = await env.FILES.get(AZAN_KEY);
      if (!obj) return json({ error: "No azan audio uploaded" }, 404);
      return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType || "audio/mpeg", "cache-control": "private, max-age=86400", etag: obj.httpEtag } });
    }
    if (method === "HEAD") {
      const obj = await env.FILES.head(AZAN_KEY);
      return new Response(null, { status: obj ? 200 : 404 });
    }
    if (method === "PUT") {
      const type = String(request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!/^audio\/(mpeg|mp3|mp4|aac|x-m4a|m4a|ogg|wav|x-wav|webm)$/.test(type)) return json({ error: "Choose an audio file (MP3, M4A, OGG or WAV)" }, 415);
      const buf = await request.arrayBuffer();
      if (!buf.byteLength) return json({ error: "The file is empty" }, 400);
      if (buf.byteLength > 10 * 1024 * 1024) return json({ error: "The file is too big (10 MB max)" }, 413);
      await env.FILES.put(AZAN_KEY, buf, { httpMetadata: { contentType: type } });
      return json({ ok: true, size: buf.byteLength });
    }
    if (method === "DELETE") {
      await env.FILES.delete(AZAN_KEY);
      return json({ ok: true });
    }
    return json({ error: "Method not allowed" }, 405);
  }
  return null;
}

async function route(request, env, user) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (path.startsWith("/api/prayer")) {
    const pr = await prayerRoute(request, env, path, method, url);
    if (pr) return pr;
  }

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

  if (taskMatch && method === "DELETE") {
    const id = taskMatch[1];
    const task = await env.DB.prepare("SELECT id FROM studio_tasks WHERE id = ?").bind(id).first();
    if (!task) return json({ error: "Task not found" }, 404);
    const { results: files } = await env.DB.prepare("SELECT object_key FROM task_attachments WHERE task_id = ?").bind(id).all();
    for (const f of files || []) await env.FILES.delete(f.object_key);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM task_attachments WHERE task_id = ?").bind(id),
      env.DB.prepare("DELETE FROM task_comments WHERE task_id = ?").bind(id),
      env.DB.prepare("DELETE FROM task_activity_logs WHERE task_id = ?").bind(id),
      env.DB.prepare("DELETE FROM studio_tasks WHERE id = ?").bind(id)
    ]);
    return json({ deleted: true });
  }

  // Edit and delete clients / projects. Deleting unlinks children instead of deleting them.
  const clientMatch = path.match(/^\/api\/clients\/([^/]+)$/);
  const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if ((clientMatch || projectMatch) && method === "PATCH") {
    const isClient = !!clientMatch;
    const id = (clientMatch || projectMatch)[1];
    const table = isClient ? "studio_clients" : "studio_projects";
    const b = await bodyJson(request);
    if (!b) return json({ error: "Invalid JSON body" }, 400);
    const existing = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first();
    if (!existing) return json({ error: isClient ? "Client not found" : "Project not found" }, 404);
    const allowed = isClient ? {
      client_name: v => cleanString(v, 200) || undefined,
      business_name: v => cleanString(v, 200),
      client_type: v => ["individual", "business"].includes(v) ? v : undefined,
      email: v => cleanString(v, 254),
      phone: v => cleanString(v, 50),
      status: v => ["active", "inactive", "archived"].includes(v) ? v : undefined,
      notes: v => cleanString(v, 5000)
    } : {
      project_name: v => cleanString(v, 200) || undefined,
      description: v => cleanString(v, 5000),
      client_id: v => cleanString(v, 100),
      status: v => ["planning", "active", "on_hold", "completed", "cancelled"].includes(v) ? v : undefined,
      priority: v => ["low", "medium", "high", "urgent"].includes(v) ? v : undefined,
      start_date: v => cleanString(v, 30),
      due_date: v => cleanString(v, 30)
    };
    const fields = [], values = [];
    for (const [key, validator] of Object.entries(allowed)) {
      if (Object.prototype.hasOwnProperty.call(b, key)) {
        const value = validator(b[key]);
        if (value !== undefined) { fields.push(`${key} = ?`); values.push(value); }
      }
    }
    if (!fields.length) return json({ error: "No valid fields to update" }, 400);
    fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    values.push(id);
    await env.DB.prepare(`UPDATE ${table} SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
    return json({ data: await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first() });
  }
  if (clientMatch && method === "DELETE") {
    const id = clientMatch[1];
    await env.DB.batch([
      env.DB.prepare("UPDATE studio_projects SET client_id = NULL WHERE client_id = ?").bind(id),
      env.DB.prepare("UPDATE studio_tasks SET client_id = NULL WHERE client_id = ?").bind(id),
      env.DB.prepare("DELETE FROM studio_clients WHERE id = ?").bind(id)
    ]);
    return json({ deleted: true });
  }
  if (projectMatch && method === "DELETE") {
    const id = projectMatch[1];
    await env.DB.batch([
      env.DB.prepare("UPDATE studio_tasks SET project_id = NULL WHERE project_id = ?").bind(id),
      env.DB.prepare("DELETE FROM studio_projects WHERE id = ?").bind(id)
    ]);
    return json({ deleted: true });
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

  if (path.startsWith("/api/web/")) {
    const res = await webLogs(request, env, path, method);
    if (res) return res;
  }

  // Website health check: the dashboard sends its site URLs, the Worker fetches each one and
  // reports up/down, HTTP status and response time. Max 12 sites, 8 s timeout each.
  if (path === "/api/web/status" && method === "POST") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== env.APP_ORIGIN) return json({ error: "Origin not allowed" }, 403);
    const b = await bodyJson(request);
    const sites = Array.isArray(b && b.sites) ? b.sites.slice(0, 12) : [];
    const checks = await Promise.all(sites.map(async (s) => {
      const id = cleanString(s && s.id, 100);
      let url;
      try { url = new URL(String(s && s.url || "")); } catch { return { id, ok: false, error: "Invalid URL" }; }
      if (url.protocol !== "https:" && url.protocol !== "http:") return { id, ok: false, error: "Invalid URL" };
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(url.href, {
          method: "GET", redirect: "follow", signal: ctrl.signal,
          headers: { "User-Agent": "FiqStudio-Status/1.0 (+uptime check)", "Accept": "text/html,*/*" }
        });
        const ms = Date.now() - started;
        try { await res.body?.cancel(); } catch {}
        return { id, ok: res.status < 400, status: res.status, ms, error: res.status >= 400 ? `HTTP ${res.status}` : "" };
      } catch (e) {
        const ms = Date.now() - started;
        return { id, ok: false, status: 0, ms, error: e && e.name === "AbortError" ? "No response after 8 seconds" : "Could not connect" };
      } finally { clearTimeout(timer); }
    }));
    return json({ checkedAt: new Date().toISOString(), results: checks });
  }

  // Owner pass for the task app: only reachable here, behind Cloudflare Access. Signs a one-time pass
  // (HMAC-SHA256 with TASK_HANDOFF_SECRET, valid 60 s) and sends the owner to the task app's /auth/owner.
  if (path === "/api/pm/handoff" && method === "GET") {
    const secret = String(env.TASK_HANDOFF_SECRET || "");
    if (secret.length < 16) return json({ error: "Task app sign-in is not set up yet (TASK_HANDOFF_SECRET)" }, 503);
    const appUrl = String(env.TASK_APP_URL || "https://fiqstudio-task.wafiq-ggle.workers.dev").replace(/\/+$/, "");
    const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const payload = b64u(new TextEncoder().encode(JSON.stringify({
      sub: "owner", name: "Fiq", email: user.email || "", exp: Math.floor(Date.now() / 1000) + 60,
      nonce: b64u(crypto.getRandomValues(new Uint8Array(18)))
    })));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
    const theme = url.searchParams.get("theme");
    const dest = `${appUrl}/auth/owner?t=${payload}.${sig}${theme === "dark" || theme === "light" ? "&theme=" + theme : ""}`;
    return new Response(null, { status: 302, headers: { location: dest, "cache-control": "no-store" } });
  }

  // Summary for the Hub "Task Management" widget, read from the task app's pm_docs table.
  if (path === "/api/pm/summary" && method === "GET") {
    const empty = { openTasks: 0, dueToday: 0, overdue: 0, activeProjects: 0, next: [] };
    let rows;
    try {
      ({ results: rows } = await env.DB.prepare("SELECT collection, data FROM pm_docs WHERE collection IN ('tasks','projects')").all());
    } catch { return json(empty); }
    const today = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Kuala_Lumpur" }).slice(0, 10);
    const tasks = [], projects = [];
    for (const r of rows || []) {
      let d; try { d = JSON.parse(r.data); } catch { continue; }
      (r.collection === "tasks" ? tasks : projects).push(d);
    }
    const open = tasks.filter(t => t.status !== "done");
    const due = t => (typeof t.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.due)) ? t.due : "";
    const rank = { High: 0, Medium: 1, Low: 2 };
    const next = open.filter(t => due(t))
      .sort((a, b) => due(a).localeCompare(due(b)) || (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1))
      .slice(0, 3)
      .map(t => ({ title: String(t.title || "Untitled task").slice(0, 120), due: due(t), priority: rank[t.priority] !== undefined ? t.priority : "Medium" }));
    return json({
      openTasks: open.length,
      dueToday: open.filter(t => due(t) === today).length,
      overdue: open.filter(t => due(t) && due(t) < today).length,
      activeProjects: projects.filter(p => (parseInt(p.progress) || 0) < 100).length,
      next, today
    });
  }

  // Plain-text snapshot of the Task Manager for Fiq AI (read-only, behind Access like everything here).
  if (path === "/api/pm/brief" && method === "GET") {
    let rows;
    try {
      ({ results: rows } = await env.DB.prepare("SELECT collection, id, data FROM pm_docs WHERE collection IN ('tasks','projects','clients')").all());
    } catch { return json({ text: "Task Manager has no data yet." }); }
    const col = { tasks: [], projects: new Map(), clients: new Map() };
    for (const r of rows || []) {
      let d; try { d = JSON.parse(r.data); } catch { continue; }
      if (r.collection === "tasks") col.tasks.push(d); else col[r.collection].set(r.id, d);
    }
    const today = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Kuala_Lumpur" }).slice(0, 10);
    const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    const due = t => (typeof t.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.due)) ? t.due : "";
    const STATUS = { todo: "To Do", prog: "In Progress", rev: "Review", hold: "On Hold", done: "Completed" };
    const STAGE = ["Discovery", "Design", "Development", "Review", "Launched"];
    const clientName = id => clip(col.clients.get(id)?.name, 60);
    const projLabel = id => {
      const p = col.projects.get(id); if (!p) return "";
      const c = clientName(p.clientId);
      return clip(p.name, 60) + (c ? " / " + c : "");
    };
    const rank = { High: 0, Medium: 1, Low: 2 };
    const open = col.tasks.filter(t => t.status !== "done")
      .sort((a, b) => (due(a) || "9999").localeCompare(due(b) || "9999") || (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1));
    const done = col.tasks.length - open.length;
    const lines = [
      `Task Manager snapshot (today ${today}, Malaysia time).`,
      `Open tasks: ${open.length}. Overdue: ${open.filter(t => due(t) && due(t) < today).length}. Due today: ${open.filter(t => due(t) === today).length}. Completed: ${done}.`
    ];
    if (open.length) {
      lines.push("Open tasks (soonest first):");
      for (const t of open.slice(0, 40)) {
        const d = due(t);
        const flag = d && d < today ? " OVERDUE" : d === today ? " DUE TODAY" : "";
        lines.push(`- ${clip(t.title, 120) || "Untitled task"} | ${STATUS[t.status] || "To Do"} | ${rank[t.priority] !== undefined ? t.priority : "Medium"} | due ${d || "none"}${flag} | ${clip(t.assignee, 40) || "unassigned"}${t.projectId && projLabel(t.projectId) ? " | " + projLabel(t.projectId) : ""}`);
      }
      if (open.length > 40) lines.push(`(+${open.length - 40} more open tasks)`);
    }
    const projects = [...col.projects.values()];
    if (projects.length) {
      lines.push("Projects:");
      for (const p of projects.slice(0, 25)) {
        const c = clientName(p.clientId);
        lines.push(`- ${clip(p.name, 80) || "Untitled project"}${c ? " (" + c + ")" : ""} | ${STAGE[Math.min(4, Math.max(0, parseInt(p.stage) || 0))]} | ${Math.min(100, Math.max(0, parseInt(p.progress) || 0))}%${due(p) ? " | deadline " + due(p) : ""}`);
      }
    }
    if (col.clients.size) lines.push("Clients: " + [...col.clients.values()].map(c => clip(c.name, 60)).filter(Boolean).slice(0, 40).join(", ") + ".");
    return json({ text: lines.join("\n").slice(0, 6000) }, 200, { "cache-control": "no-store" });
  }

  if (path === "/api/settings") {
    const res = await settingsSync(request, env, method);
    if (res) return res;
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