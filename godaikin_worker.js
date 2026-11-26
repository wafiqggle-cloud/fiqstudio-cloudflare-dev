/**
 * FiqStudio - GO DAIKIN Direct Cloud Worker (No Home Assistant Needed)
 *
 * Deploy on Cloudflare Workers (Free Tier):
 * 1. Create a new Worker (e.g. "godaikin-hub") and paste this entire file.
 * 2. In Worker Settings -> Variables and Secrets, add 3 Encrypted Secrets:
 *      - DAIKIN_EMAIL     : your GO DAIKIN app email
 *      - DAIKIN_PASSWORD  : your GO DAIKIN app password
 *      - API_SECRET       : any secret PIN/password you choose (paste same into FiqStudio)
 * 3. Copy your Worker URL (e.g. https://godaikin-hub.yourname.workers.dev)
 *    into FiqStudio -> Settings -> Devices -> GO DAIKIN Worker.
 */

const COGNITO_URL = "https://cognito-idp.ap-southeast-1.amazonaws.com/";
const COGNITO_CLIENT_ID = "36f6piu770fotfscvhi3jb1vb7";
const DAIKIN_API_BASE = "https://c7zkf7l933.execute-api.ap-southeast-1.amazonaws.com/prod/";

const MODE_TO_INT = { cool: 1, fan_only: 2, dry: 4 };
const INT_TO_MODE = { 1: "cool", 2: "fan_only", 4: "dry" };
const FAN_TO_INT = { auto: 128, low: 2, medium: 4, high: 8 };
const INT_TO_FAN = { 128: "auto", 2: "low", 4: "medium", 8: "high" };

// Warm-isolate token cache
let cachedToken = null; // { idToken, refreshToken, expiresAt }

// Security: per-IP failed-auth rate limiter (max 20 failures per 15 min)
const FAILED_AUTH_MAP = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILS = 20;

function getAllowedOrigin(request, env) {
  const allowed = String(env?.ALLOWED_ORIGIN || "https://fiqstudio.page.gd").trim();
  const origin = request.headers.get("Origin") || "";
  if (origin === allowed) return allowed;
  return allowed;
}

function buildCorsHeaders(request, env) {
  return {
    "Access-Control-Allow-Origin": getAllowedOrigin(request, env),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Secret",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

function jsonResponse(data, status = 200, request = null, env = null) {
  const cors = request ? buildCorsHeaders(request, env) : { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function timingSafeEqualStr(a, b) {
  const sa = String(a || "");
  const sb = String(b || "");
  if (sa.length !== sb.length || sa.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

function checkRateLimit(ip) {
  const now = Date.now();
  const rec = FAILED_AUTH_MAP.get(ip);
  if (!rec || now > rec.resetAt) return { blocked: false };
  return { blocked: rec.count >= RATE_MAX_FAILS, retryAfterSec: Math.ceil((rec.resetAt - now) / 1000) };
}

function recordAuthFailure(ip) {
  const now = Date.now();
  const rec = FAILED_AUTH_MAP.get(ip);
  if (!rec || now > rec.resetAt) {
    FAILED_AUTH_MAP.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
  } else {
    rec.count += 1;
  }
}

function isAuthorized(request, env) {
  // Security: fail closed if API_SECRET is missing
  const expected = String(env.API_SECRET || "").trim();
  if (!expected) return false;
  const hSecret = request.headers.get("X-API-Secret") || "";
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const url = new URL(request.url);
  const qSecret = url.searchParams.get("secret") || "";
  return timingSafeEqualStr(hSecret, expected) || timingSafeEqualStr(bearer, expected) || timingSafeEqualStr(qSecret, expected);
}

async function cognitoInitiateAuth(authFlow, authParameters) {
  const res = await fetch(COGNITO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      ClientId: COGNITO_CLIENT_ID,
      AuthFlow: authFlow,
      AuthParameters: authParameters,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.AuthenticationResult) {
    throw new Error(data.message || data.__type || `Cognito auth failed (HTTP ${res.status})`);
  }
  return data.AuthenticationResult;
}

async function getIdToken(env, forceRefresh = false) {
  const email = String(env.DAIKIN_EMAIL || "").trim();
  const password = String(env.DAIKIN_PASSWORD || "").trim();
  if (!email || !password) {
    throw new Error("Missing DAIKIN_EMAIL or DAIKIN_PASSWORD secrets in Cloudflare Worker.");
  }

  const now = Date.now();
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > now + 5 * 60 * 1000) {
    return cachedToken.idToken;
  }

  // Try refresh token first if available
  if (cachedToken && cachedToken.refreshToken) {
    try {
      const auth = await cognitoInitiateAuth("REFRESH_TOKEN_AUTH", {
        REFRESH_TOKEN: cachedToken.refreshToken,
      });
      cachedToken = {
        idToken: auth.IdToken,
        refreshToken: cachedToken.refreshToken,
        expiresAt: now + (Number(auth.ExpiresIn) || 3600) * 1000,
      };
      return cachedToken.idToken;
    } catch (_) {
      cachedToken = null;
    }
  }

  // Fresh login via USER_PASSWORD_AUTH
  const auth = await cognitoInitiateAuth("USER_PASSWORD_AUTH", {
    USERNAME: email,
    PASSWORD: password,
  });
  cachedToken = {
    idToken: auth.IdToken,
    refreshToken: auth.RefreshToken,
    expiresAt: now + (Number(auth.ExpiresIn) || 3600) * 1000,
  };
  return cachedToken.idToken;
}

async function daikinPost(env, endpoint, payload, retryAuth = true) {
  const idToken = await getIdToken(env, false);
  const res = await fetch(`${DAIKIN_API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: idToken,
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 401 && retryAuth) {
    await getIdToken(env, true);
    return daikinPost(env, endpoint, payload, false);
  }

  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(json.message || `GO DAIKIN API error (HTTP ${res.status})`);
  }
  return json;
}

async function fetchAirconds(env) {
  const email = String(env.DAIKIN_EMAIL || "").trim();
  const data = await daikinPost(env, "gethomepageinfowithsubscription", {
    requestData: { type: 1, value: email },
  });

  const list = Array.isArray(data.data) ? data.data : [];
  return list.map((item) => {
    const ss = item.shadowState || {};
    return {
      id: "daikin_" + String(item.ThingName || item.ACName || Math.random()).toLowerCase().replace(/[^a-z0-9_]/g, "_"),
      name: item.ACName || item.ThingName || "GO DAIKIN AC",
      thingName: item.ThingName || "",
      shadowKey: ss.key || "",
      type: "climate",
      power: Number(ss.Set_OnOff) === 1,
      temp: Number(ss.Set_Temp) || 24,
      currentTemp: typeof ss.Sta_IDRoomTemp === "number" ? ss.Sta_IDRoomTemp : null,
      outdoorTemp: typeof ss.Sta_ODAirTemp === "number" ? ss.Sta_ODAirTemp : null,
      powerWatts: typeof ss.Sta_ODPwrCon === "number" ? ss.Sta_ODPwrCon : null,
      mode: INT_TO_MODE[Number(ss.Set_Mode)] || "cool",
      fan: INT_TO_FAN[Number(ss.Set_Fan)] || "auto",
      swing: Number(ss.Set_Swing) === 1,
      preset: Number(ss.Set_Turbo) === 1 ? "boost" : (Number(ss.Set_Breeze) === 1 ? "comfort" : (Number(ss.Set_Ecoplus) === 1 ? "eco" : (Number(ss.Set_Sleep) === 1 ? "sleep" : "none"))),
      connected: ss.eventType === "connected",
      updatedOn: ss.updatedOn || "",
    };
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: buildCorsHeaders(request, env) });
    }

    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const rl = checkRateLimit(clientIp);
    if (rl.blocked) {
      return jsonResponse({ ok: false, error: "Too many failed attempts. Try again later." }, 429, request, env);
    }
    if (!isAuthorized(request, env)) {
      recordAuthFailure(clientIp);
      return jsonResponse({ ok: false, error: "Unauthorized" }, 401, request, env);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      // GET / or /api/devices - list all GO DAIKIN units & live status
      if (request.method === "GET" && (path === "/" || path === "/api/devices" || path === "/api/status")) {
        const devices = await fetchAirconds(env);
        return jsonResponse({ ok: true, updatedAt: new Date().toISOString(), devices }, 200, request, env);
      }

      // POST /api/control - turn ON/OFF, set temperature, mode, or fan
      if (request.method === "POST" && (path === "/api/control" || path === "/")) {
        const body = await request.json().catch(() => ({}));
        let thingName = String(body.thingName || "").trim();
        let shadowKey = String(body.shadowKey || body.key || "").trim();

        // Auto-resolve first AC or missing shadowKey if needed
        if (!thingName || !shadowKey) {
          const units = await fetchAirconds(env);
          if (!units.length) {
            return jsonResponse({ ok: false, error: "No GO DAIKIN air conditioners found on this account." }, 404, request, env);
          }
          const matched = thingName ? units.find((u) => u.thingName === thingName) : units[0];
          if (!matched) {
            return jsonResponse({ ok: false, error: `Air conditioner '${thingName}' not found.` }, 404, request, env);
          }
          thingName = matched.thingName;
          shadowKey = matched.shadowKey;
        }

        const desired = {};
        if (typeof body.power === "boolean") {
          desired.Set_OnOff = body.power ? 1 : 0;
        }
        if (typeof body.temp === "number" && isFinite(body.temp)) {
          desired.Set_Temp = Math.max(16, Math.min(31, Math.round(body.temp)));
        }
        if (typeof body.mode === "string" && MODE_TO_INT[body.mode]) {
          desired.Set_Mode = MODE_TO_INT[body.mode];
          if (desired.Set_OnOff === undefined) desired.Set_OnOff = 1;
        }
        if (typeof body.fan === "string" && FAN_TO_INT[body.fan]) {
          desired.Set_Fan = FAN_TO_INT[body.fan];
        }
        if (typeof body.swing === "boolean") {
          desired.Set_Swing = body.swing ? 1 : 0;
          desired.Set_UDLvr = body.swing ? 15 : 0;
        }
        if (typeof body.preset === "string") {
          desired.Set_Breeze = 0;
          desired.Set_Ecoplus = 0;
          desired.Set_Silent = 0;
          desired.Set_Sleep = 0;
          desired.Set_SmEcomax = 0;
          desired.Set_SmSleepplus = 0;
          desired.Set_SmPwrfulplus = 0;
          desired.Set_Turbo = 0;
          if (body.preset === "comfort") desired.Set_Breeze = 1;
          else if (body.preset === "eco") desired.Set_Ecoplus = 1;
          else if (body.preset === "boost") desired.Set_Turbo = 1;
          else if (body.preset === "sleep") desired.Set_Sleep = 1;
        }

        if (Object.keys(desired).length === 0) {
          return jsonResponse({ ok: false, error: "No control fields provided (power, temp, mode, or fan)." }, 400, request, env);
        }

        const email = String(env.DAIKIN_EMAIL || "").trim();
        await daikinPost(env, "publishdevicestate", {
          requestData: {
            type: 3,
            username: email,
            thingName,
            key: shadowKey,
            payload: { state: { desired } },
          },
        });

        return jsonResponse({ ok: true, thingName, applied: desired }, 200, request, env);
      }

      return jsonResponse({ ok: false, error: "Not found. Use GET /api/devices or POST /api/control." }, 404, request, env);
    } catch (err) {
      console.error("GO DAIKIN Worker error:", err);
      const msg = env.DEBUG === "true" ? (err && err.message ? err.message : "Worker error") : "Upstream device request failed";
      return jsonResponse({ ok: false, error: msg }, 500, request, env);
    }
  },
};