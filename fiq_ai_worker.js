/**
 * FiqStudio - Multi-Provider AI Agent Worker (Gemini / OpenAI / Anthropic Claude)
 * Tools: Live Weather (Open-Meteo) and GO DAIKIN AC Control
 *
 * Deploy on Cloudflare Workers (Free Tier):
 * 1. Create a new Worker (e.g. "fiq-ai") and paste this entire file.
 * 2. In Worker Settings -> Variables and Secrets, add Encrypted Secrets:
 *      - API_SECRET         : your private PIN/password for FiqStudio chat
 *      - AI_PROVIDER        : "gemini" (default, free tier), "openai", or "anthropic"
 *      - GEMINI_API_KEY     : from https://aistudio.google.com/apikey (if gemini)
 *      - OPENAI_API_KEY     : from https://platform.openai.com (if openai)
 *      - ANTHROPIC_API_KEY  : from https://console.anthropic.com (if anthropic)
 *      - DAIKIN_WORKER_URL  : https://godaikin-hub.wafiq-ggle.workers.dev
 *      - DAIKIN_API_SECRET  : same API_SECRET used by your godaikin-hub Worker
 */

const FAILED_AUTH_MAP = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILS = 20;

const SYSTEM_PROMPT = `You are Fiq AI, Wafiq's personal HomeLab assistant inside FiqStudio (Kota Bharu, Kelantan, Malaysia).
Be helpful, concise, and friendly. You can answer general everyday questions directly, and you also have live tools to check weather and check/control Wafiq's GO DAIKIN air conditioner.
When replying for voice playback, keep answers clear and natural without excessive markdown symbols.`;

function getAllowedOrigin(request, env) {
  const custom = String(env?.ALLOWED_ORIGIN || "").trim();
  const origin = request.headers.get("Origin") || "";
  if (custom) return origin === custom ? custom : custom;
  return origin || "*";
}

function buildCorsHeaders(request, env) {
  return {
    "Access-Control-Allow-Origin": getAllowedOrigin(request, env),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Secret",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

function jsonResponse(data, status = 200, request = null, env = null) {
  const cors = request
    ? buildCorsHeaders(request, env)
    : { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
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
  return { blocked: rec.count >= RATE_MAX_FAILS };
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
  const expected = String(env.API_SECRET || "").trim();
  if (!expected) return false;
  const hSecret = request.headers.get("X-API-Secret") || "";
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return timingSafeEqualStr(hSecret, expected) || timingSafeEqualStr(bearer, expected);
}

// ============================================================================
// TOOL DEFINITIONS (shared schema)
// ============================================================================
const TOOL_SCHEMAS = [
  {
    name: "get_weather",
    description: "Get live current weather and rain forecast for a city (defaults to Kota Bharu, Malaysia).",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name, e.g. Kota Bharu or Kuala Lumpur" },
      },
      required: [],
    },
  },
  {
    name: "get_ac_status",
    description: "Read the live status of Wafiq's GO DAIKIN air conditioner (power, target temp, room temp, mode, fan).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "control_ac",
    description: "Control Wafiq's GO DAIKIN air conditioner (turn on/off, set temperature 16-30C, mode, or fan).",
    parameters: {
      type: "object",
      properties: {
        power: { type: "boolean", description: "true to turn ON, false to turn OFF" },
        temp: { type: "number", description: "Target temperature in Celsius (16 to 30)" },
        mode: { type: "string", enum: ["cool", "fan_only", "dry"], description: "AC operating mode" },
        fan: { type: "string", enum: ["auto", "low", "medium", "high"], description: "Fan speed" },
      },
      required: [],
    },
  },
];

// ============================================================================
// TOOL EXECUTION
// ============================================================================
async function executeTool(name, args, env, clientContext) {
  if (name === "get_weather") {
    const city = String(args?.city || "Kota Bharu").trim();
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
    );
    const geo = await geoRes.json().catch(() => ({}));
    const loc = geo?.results?.[0] || { name: "Kota Bharu", country: "Malaysia", latitude: 6.1254, longitude: 102.2386 };
    const wRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&hourly=precipitation_probability&forecast_days=1&timezone=Asia%2FKuala_Lumpur`
    );
    const w = await wRes.json().catch(() => ({}));
    const cur = w?.current || {};
    const maxRainProb = Array.isArray(w?.hourly?.precipitation_probability)
      ? Math.max(...w.hourly.precipitation_probability.slice(0, 12))
      : null;
    return {
      ok: true,
      location: `${loc.name}, ${loc.country || ""}`.trim(),
      temperature_c: cur.temperature_2m,
      feels_like_c: cur.apparent_temperature,
      humidity_pct: cur.relative_humidity_2m,
      wind_kmh: cur.wind_speed_10m,
      precipitation_mm: cur.precipitation,
      next_12h_rain_chance_pct: maxRainProb,
    };
  }

  if (name === "get_ac_status" || name === "control_ac") {
    const base = String(env.DAIKIN_WORKER_URL || "")
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/api\/(devices|control)$/i, "");
    const secret = String(env.DAIKIN_API_SECRET || "").trim();
    const useBinding = Boolean(env.DAIKIN_SERVICE && typeof env.DAIKIN_SERVICE.fetch === "function");
    if (!useBinding && !base) {
      return { ok: false, error: "Bind DAIKIN_SERVICE or set DAIKIN_WORKER_URL in fiq-ai Worker settings." };
    }
    const headers = { "Content-Type": "application/json" };
    if (secret) headers["X-API-Secret"] = secret;

    const callDaikin = (path, init) => {
      if (useBinding) {
        return env.DAIKIN_SERVICE.fetch(`https://godaikin-hub.internal${path}`, init);
      }
      return fetch(`${base}${path}`, init);
    };

    if (name === "get_ac_status") {
      const res = await callDaikin("/api/devices", { method: "GET", headers });
      return await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    }
    const payload = {};
    if (typeof args?.power === "boolean") payload.power = args.power;
    if (typeof args?.temp === "number") payload.temp = Math.min(30, Math.max(16, Math.round(args.temp)));
    if (args?.mode) payload.mode = args.mode;
    if (args?.fan) payload.fan = args.fan;
    const res = await callDaikin("/api/control", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    return await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  }

  return { ok: false, error: `Unknown tool: ${name}` };
}

// ============================================================================
// PROVIDER ADAPTERS: GEMINI (Free Tier), OPENAI, ANTHROPIC
// ============================================================================
async function runGemini(messages, env, clientContext) {
  const apiKey = String(env.GEMINI_API_KEY || "").trim();
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY secret");
  const model = String(env.GEMINI_MODEL || "gemini-2.5-flash").trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content || "") }],
  }));

  const tools = [{
    functionDeclarations: TOOL_SCHEMAS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  }];

  const usedTools = [];
  for (let step = 0; step < 4; step++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        tools,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `Gemini HTTP ${res.status}`);

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const fnCalls = parts.filter((p) => p.functionCall);
    if (fnCalls.length === 0) {
      const text = parts.map((p) => p.text || "").join("").trim();
      return { reply: text || "Done.", toolsUsed: usedTools };
    }

    contents.push({ role: "model", parts });
    const fnResponses = [];
    for (const p of fnCalls) {
      const { name, args } = p.functionCall;
      usedTools.push(name);
      const result = await executeTool(name, args || {}, env, clientContext);
      fnResponses.push({ functionResponse: { name, response: { result } } });
    }
    contents.push({ role: "user", parts: fnResponses });
  }
  return { reply: "Completed requested actions.", toolsUsed: usedTools };
}

async function runOpenAI(messages, env, clientContext) {
  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY secret");
  const model = String(env.OPENAI_MODEL || "gpt-4o-mini").trim();

  const chat = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") })),
  ];
  const tools = TOOL_SCHEMAS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const usedTools = [];
  for (let step = 0; step < 4; step++) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: chat, tools }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${res.status}`);

    const msg = data?.choices?.[0]?.message;
    if (!msg?.tool_calls || msg.tool_calls.length === 0) {
      return { reply: String(msg?.content || "Done.").trim(), toolsUsed: usedTools };
    }
    chat.push(msg);
    for (const tc of msg.tool_calls) {
      const name = tc.function.name;
      const args = JSON.parse(tc.function.arguments || "{}");
      usedTools.push(name);
      const result = await executeTool(name, args, env, clientContext);
      chat.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return { reply: "Completed requested actions.", toolsUsed: usedTools };
}

async function runAnthropic(messages, env, clientContext) {
  const apiKey = String(env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY secret");
  const model = String(env.ANTHROPIC_MODEL || "claude-sonnet-5-5").trim();

  const chat = messages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || ""),
  }));
  const tools = TOOL_SCHEMAS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  const usedTools = [];
  for (let step = 0; step < 4; step++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 4096, system: SYSTEM_PROMPT, messages: chat, tools }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `Anthropic HTTP ${res.status}`);

    const blocks = Array.isArray(data.content) ? data.content : [];
    const toolUses = blocks.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      return { reply: text || "Done.", toolsUsed: usedTools };
    }
    chat.push({ role: "assistant", content: blocks });
    const toolResults = [];
    for (const tu of toolUses) {
      usedTools.push(tu.name);
      const result = await executeTool(tu.name, tu.input || {}, env, clientContext);
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    chat.push({ role: "user", content: toolResults });
  }
  return { reply: "Completed requested actions.", toolsUsed: usedTools };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: buildCorsHeaders(request, env) });
    }

    const reqUrl = new URL(request.url);
    if (request.method === "GET" && (reqUrl.pathname === "/" || reqUrl.pathname === "/api/health")) {
      return jsonResponse({
        ok: true,
        service: "fiq-ai",
        provider: String(env.AI_PROVIDER || "gemini").toLowerCase(),
        hasSecret: Boolean(String(env.API_SECRET || "").trim()),
      }, 200, request, env);
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

    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/health") {
        return jsonResponse({ ok: true, provider: String(env.AI_PROVIDER || "gemini").toLowerCase() }, 200, request, env);
      }

      if (request.method === "POST" && (url.pathname === "/api/chat" || url.pathname === "/")) {
        const body = await request.json().catch(() => ({}));
        const rawMessages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
        if (rawMessages.length === 0) {
          return jsonResponse({ ok: false, error: "Missing messages array" }, 400, request, env);
        }
        const provider = String(env.AI_PROVIDER || "gemini").trim().toLowerCase();
        const ctx = body.context && typeof body.context === "object" ? body.context : {};
        let out;
        if (provider === "openai") out = await runOpenAI(rawMessages, env, ctx);
        else if (provider === "anthropic" || provider === "claude") out = await runAnthropic(rawMessages, env, ctx);
        else out = await runGemini(rawMessages, env, ctx);

        return jsonResponse({ ok: true, provider, reply: out.reply, toolsUsed: out.toolsUsed }, 200, request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/tts") {
        const elKey = String(env.ELEVENLABS_API_KEY || "").trim();
        if (!elKey) {
          return jsonResponse({ ok: false, error: "ELEVENLABS_API_KEY is not set" }, 501, request, env);
        }
        const body = await request.json().catch(() => ({}));
        const text = String(body.text || "").trim().slice(0, 1000);
        if (!text) {
          return jsonResponse({ ok: false, error: "Missing text" }, 400, request, env);
        }
        const FREE_FALLBACK_VOICE = "EXAVITQu4vr4xnSDxMaL"; // Sarah (premade female, free-tier compatible)
        const voiceId = String(body.voiceId || env.ELEVENLABS_VOICE_ID || FREE_FALLBACK_VOICE).trim();
        const modelId = String(env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5").trim();
        const callElevenLabs = (vid) => fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}?output_format=mp3_44100_128`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "xi-api-key": elKey,
              "Accept": "audio/mpeg",
            },
            body: JSON.stringify({
              text,
              model_id: modelId,
              voice_settings: { stability: 0.50, similarity_boost: 0.75, style: 0.15, use_speaker_boost: false },
            }),
          }
        );
        let ttsRes = await callElevenLabs(voiceId);
        if (ttsRes.status === 402 && voiceId !== FREE_FALLBACK_VOICE) {
          ttsRes = await callElevenLabs(FREE_FALLBACK_VOICE);
        }
        if (!ttsRes.ok) {
          const errTxt = await ttsRes.text().catch(() => "");
          return jsonResponse({ ok: false, error: `ElevenLabs HTTP ${ttsRes.status}: ${errTxt.slice(0, 120)}` }, 502, request, env);
        }
        const audioBuf = await ttsRes.arrayBuffer();
        return new Response(audioBuf, {
          status: 200,
          headers: {
            "Content-Type": "audio/mpeg",
            ...buildCorsHeaders(request, env),
          },
        });
      }

      return jsonResponse({ ok: false, error: "Not found. Use POST /api/chat or POST /api/tts." }, 404, request, env);
    } catch (err) {
      console.error("Fiq AI Worker error:", err);
      const msg = env.DEBUG === "true" ? (err?.message || String(err)) : "AI request failed. Check Worker secrets.";
      return jsonResponse({ ok: false, error: msg }, 500, request, env);
    }
  },
};