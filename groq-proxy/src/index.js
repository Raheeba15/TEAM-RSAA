// Cloudflare Worker: forwards chat requests from the TEAM-RSAA web app to Groq,
// so the Groq API key stays on the server instead of in the website's code.
// The key is stored as a Worker secret: npx wrangler secret put GROQ_API_KEY

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

// Only these sites may call the proxy from a browser
const ALLOWED_ORIGINS = [
  "https://team-rsaa-ec75b.web.app",
  "https://team-rsaa-ec75b.firebaseapp.com",
];
// Local dev server (any port), on this PC or the LAN
const DEV_ORIGIN = /^https:\/\/(localhost|127\.0\.0\.1|(10|172|192)\.[0-9.]+)(:\d+)?$/;

// Limit what the key can be used for if someone calls the proxy directly
const ALLOWED_MODELS = new Set(["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"]);
const MAX_TOKENS_CAP = 1000;
const MAX_BODY_BYTES = 20_000;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin) || DEV_ORIGIN.test(origin);
    if (!allowed) return json(403, { error: { message: "Origin not allowed" } });
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json(405, { error: { message: "Use POST" } }, cors);
    if (!env.GROQ_API_KEY) return json(500, { error: { message: "Proxy is missing GROQ_API_KEY" } }, cors);

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: { message: "Request too large" } }, cors);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: { message: "Invalid JSON" } }, cors);
    }
    if (!ALLOWED_MODELS.has(body.model)) {
      // 404 lets the app fall through to its next backup model
      return json(404, { error: { message: `Model ${body.model} is not allowed by the proxy` } }, cors);
    }
    body.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS_CAP, MAX_TOKENS_CAP);
    delete body.stream;

    const upstream = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...cors },
    });
  },
};
