import { generateRoomCode, normalizeRoomCode } from "./room-code";

export { CreationLimiter } from "./creation-limiter";
export { Room } from "./room";

const MAX_CREATE_ATTEMPTS = 5;

// Any page's content script may call this server, and there are no cookies or
// accounts for another origin to abuse, so CORS stays open.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: CORS_HEADERS });
}

const toHex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * With a secret set, the hash can't be reversed by hashing every IPv4 address, which a plain
 * SHA-256 of one can. Without it, it still works, as before.
 */
async function hashOf(value: string, env: Cloudflare.Env): Promise<string> {
  const data = new TextEncoder().encode(value);
  if (!env.IP_HASH_KEY) return toHex(await crypto.subtle.digest("SHA-256", data));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.IP_HASH_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, data));
}

async function createRoom(request: Request, env: Cloudflare.Env): Promise<Response> {
  // Rooms cost storage and anyone can ask for one, so one address can't ask endlessly.
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const limiter = env.CREATION_LIMITERS.getByName(await hashOf(address, env));
  if (!(await limiter.allow())) return text("Too many rooms", 429);

  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
    const code = generateRoomCode();
    const created = await env.ROOMS.getByName(code).create();
    if (created) return json({ code }, 201);
  }
  return text("Could not create a room", 503);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (pathname === "/health") return json({ ok: true });
    if (pathname === "/rooms") {
      return request.method === "POST" ? createRoom(request, env) : text("Method not allowed", 405);
    }

    const match = /^\/rooms\/([^/]+)\/ws$/.exec(pathname);
    if (match) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return text("Expected a WebSocket upgrade", 426);
      }
      // Checked here so malformed codes never instantiate a Durable Object.
      const code = normalizeRoomCode(decodeURIComponent(match[1] ?? ""));
      if (!code) return text("Invalid room code", 400);
      // Every connection costs a request against the daily limit, and codes can be guessed.
      // Cloudflare always sends the address. Local runs, which don't, aren't limited.
      const address = request.headers.get("CF-Connecting-IP");
      if (address) {
        const limiter = env.CREATION_LIMITERS.getByName(`connect:${await hashOf(address, env)}`);
        if (!(await limiter.allowConnection())) return text("Too many connections", 429);
      }
      return env.ROOMS.getByName(code).fetch(request);
    }

    return text("Not found", 404);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
