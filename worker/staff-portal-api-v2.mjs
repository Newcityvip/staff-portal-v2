const legacyCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Content-Type": "application/json"
};
const secretPattern = /^[a-f0-9]{64}$/i;
const trustedIp = /^[0-9a-f:.]{3,64}$/i;
const token = /^[A-Za-z0-9_-]{1,1024}\.[a-f0-9]{64}$/;
const actions = new Map([["/roster/v1/login", "login"], ["/roster/v1/snapshot", "snapshot"]]);
const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: true });

function rosterResponse(body, status, origin = "") {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Origin",
    ...(origin ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    } : {})
  } });
}

async function boundedJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 2048) { await reader.cancel(); throw new Error("Body too large"); }
      parts.push(utf8.decode(value, { stream: true }));
    }
    parts.push(utf8.decode());
    return JSON.parse(parts.join(""));
  } finally {
    reader.releaseLock();
  }
}

export async function rosterSignature(secret, time, nonce, ip, payload) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(["roster-v1", time, nonce, ip, payload].join("\n")));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

async function roster(request, env, url, io) {
  const origin = request.headers.get("Origin");
  const operation = actions.get(url.pathname);
  if (!origin || !env.ROSTER_ORIGIN || origin !== env.ROSTER_ORIGIN) return rosterResponse({ ok: false }, 403);
  const error = status => rosterResponse({ ok: false }, status, origin);
  if (!operation || url.search) return error(404);
  if (request.method === "OPTIONS") return rosterResponse(null, 204, origin);
  if (request.method !== "POST") return error(405);
  if (env.ROSTER_ENABLED !== "1" || !secretPattern.test(env.ROSTER_BRIDGE_KEY || "") ||
    !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(env.GAS_URL || "")) return error(503);
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!io.trustedEdge(request) || request.headers.has("CF-Worker") ||
    ip.toLowerCase() === "2a06:98c0:3600::103" || !trustedIp.test(ip)) return error(403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || "")) return error(415);
  let body;
  try { body = await boundedJson(request); } catch { return error(400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return error(400);
  const allowed = operation === "login" ? ["login_id", "password"] : ["team", "month"];
  if (Object.keys(body).length !== 2 || !allowed.every(k => typeof body[k] === "string")) return error(400);
  if (operation === "login" && (!body.login_id.trim() || body.login_id.length > 128 ||
    !body.password || body.password.length > 256)) return error(400);
  const session = request.headers.get("Authorization")?.match(/^Bearer ([^ ]+)$/)?.[1] || "";
  if (operation === "snapshot" && !token.test(session)) return error(401);
  const payload = JSON.stringify(operation === "login" ? { operation, login_id: body.login_id, password: body.password } :
    { operation, team: body.team, month: body.month, session });
  try {
    const time = io.now(), nonce = crypto.randomUUID();
    const signature = await rosterSignature(env.ROSTER_BRIDGE_KEY, time, nonce, ip, payload);
    const response = await io.fetch(env.GAS_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "roster_v1", time, nonce, ip, payload, signature }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return error(502);
    const result = await response.json();
    if (![200, 400, 401, 403, 429, 503].includes(result.status)) return error(502);
    if (result.status !== 200) return error(result.status);
    if (result.body?.ok !== true) return error(502);
    return rosterResponse(result.body, 200, origin);
  } catch { return error(503); }
}

export function createPortalWorker({ fetch = (...args) => globalThis.fetch(...args), now = Date.now,
  trustedEdge = request => Boolean(request.cf && request.cf.colo) } = {}) {
  return { async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/roster/v1" || url.pathname.startsWith("/roster/v1/")) {
      return roster(request, env, url, { fetch, now, trustedEdge });
    }
    const GAS_URL = env.GAS_URL;
    if (request.method === "OPTIONS") return new Response("ok", { headers: legacyCors });
    try {
      const response = request.method === "GET" ? await fetch(GAS_URL + url.search, { method: "GET" }) :
        await fetch(GAS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: await request.text() });
      return new Response(await response.text(), { status: response.status, headers: legacyCors });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, message: err.toString() }), { status: 500, headers: legacyCors });
    }
  } };
}

export default createPortalWorker();
