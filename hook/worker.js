/**
 * FIQSTUDIO public webhook (replaces order_webhook.php for client websites).
 *
 * Public on purpose: client sites send visitors here, so there is no Access login.
 * It can only ADD entries; reading, resolving and deleting happen in the main
 * dashboard Worker (/api/web/*), which is behind Cloudflare Access.
 *
 *   GET|POST /order   ?site_id=&site_name=&package=&page_url=&to=https://wa.me/...
 *   GET|POST /report  ?site_id=&site_name=&issue_type=&reporter=&message=&page_url=&return_url=
 *   GET|POST /order_webhook.php  same as the old PHP URL (action=report -> /report, no action -> /order)
 *
 * Binding: env.DB -> D1 fiqstudio-pm-db (same database as the dashboard).
 */

const KEEP = 500;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type"
};
let tablesReady = false;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS }
});
const clip = (v, max, dflt = "") => { const s = String(v ?? "").trim().slice(0, max); return s || dflt; };
const isHttps = u => /^https:\/\/[^\s"'<>]+$/i.test(u || "");
const klTime = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Kuala_Lumpur" }).slice(0, 16);
const shortRef = () => crypto.randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase();

async function ensureTables(env) {
  if (tablesReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS web_orders (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS web_reports (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL)")
  ]);
  tablesReady = true;
}

async function params(request) {
  const out = Object.fromEntries(new URL(request.url).searchParams);
  if (request.method === "POST") {
    const text = await request.text();
    if (text.length > 8000) return null;
    const type = (request.headers.get("content-type") || "").toLowerCase();
    if (type.includes("application/x-www-form-urlencoded")) {
      // Plain HTML <form method="POST"> (keeps the message out of the URL).
      for (const [k, v] of new URLSearchParams(text)) out[k] = v;
    } else {
      try { const b = JSON.parse(text); if (b && typeof b === "object" && !Array.isArray(b)) Object.assign(out, b); } catch {}
    }
  }
  return out;
}

async function insert(env, table, id, entry) {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO ${table} (id, data, created_at) VALUES (?, ?, ?)`).bind(id, JSON.stringify(entry), new Date().toISOString()),
    env.DB.prepare(`DELETE FROM ${table} WHERE id NOT IN (SELECT id FROM ${table} ORDER BY created_at DESC LIMIT ${KEEP})`)
  ]);
}

function redirect(dest, label) {
  const safe = dest.replace(/"/g, "%22");
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safe}"></head><body>${label}</body></html>`,
    { status: 302, headers: { location: dest, "content-type": "text/html; charset=utf-8", ...CORS } }
  );
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET" && request.method !== "POST") return json({ status: "error" }, 405);
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if (path === "/") return json({ service: "FIQSTUDIO webhook", status: "ready" });
    if (!env.DB) return json({ status: "error", reason: "database not bound" }, 503);

    try {
      const p = await params(request);
      if (!p) return json({ status: "error", reason: "too large" }, 413);

      // Legacy drop-in: client sites can keep the old path and only change the domain.
      // ?action=report -> report; no action -> order click. Admin actions are refused here.
      let route = path;
      if (path === "/order_webhook.php") {
        const action = String(p.action || "").trim();
        if (action === "report") route = "/report";
        else if (!action) route = "/order";
        else return json({ status: "error", reason: "action not allowed on the public webhook" }, 403);
      }
      await ensureTables(env);

      if (route === "/report") {
        const message = clip(p.message, 2000);
        if (message) {
          const id = "rep_" + Date.now() + "_" + shortRef();
          await insert(env, "web_reports", id, {
            id, ref: "FIX-" + shortRef().slice(0, 4),
            siteId: clip(p.site_id, 60, "site_dms"), siteName: clip(p.site_name, 120, "Client Website"),
            issueType: clip(p.issue_type, 80, "General Issue"), reporter: clip(p.reporter, 120, "Client / Visitor"),
            message, pageUrl: isHttps(p.page_url) ? clip(p.page_url, 500) : "", status: "Open", timestamp: klTime()
          });
        }
        const back = clip(p.return_url, 500);
        if (isHttps(back)) return redirect(back + (back.includes("?") ? "&" : "?") + "reported=1", "Report sent to FiqStudio...");
        return json({ status: message ? "reported" : "ignored" }, message ? 200 : 400);
      }

      if (route === "/order") {
        const siteId = clip(p.site_id, 60);
        if (!siteId) return json({ status: "ignored", reason: "missing site_id" }, 400);
        const pageUrl = isHttps(p.page_url) ? clip(p.page_url, 500) : "";
        const id = "ord_" + Date.now() + "_" + shortRef();
        const ref = "ORD-" + shortRef();
        await insert(env, "web_orders", id, {
          id, ref, siteId, siteName: clip(p.site_name, 120, "Client Website"), pkg: clip(p.package, 120, "Custom Order"),
          customer: "Website Visitor", phone: "", pageUrl, stage: "Clicked Order Now",
          notes: pageUrl ? "Clicked Order Now on " + pageUrl : "Clicked Order Now", timestamp: klTime()
        });
        const to = clip(p.to, 1000);
        if (/^https:\/\/(wa\.me|api\.whatsapp\.com)\//i.test(to) && isHttps(to)) return redirect(to, "Redirecting to WhatsApp...");
        return json({ status: "logged", ref });
      }

      return json({ status: "error", reason: "not found" }, 404);
    } catch {
      return json({ status: "error", reason: "server error" }, 500);
    }
  }
};
