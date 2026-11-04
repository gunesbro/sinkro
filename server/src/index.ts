import { generateRoomCode, normalizeRoomCode } from "./room-code";

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

async function createRoom(env: Cloudflare.Env): Promise<Response> {
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
      return request.method === "POST" ? createRoom(env) : text("Method not allowed", 405);
    }

    const match = /^\/rooms\/([^/]+)\/ws$/.exec(pathname);
    if (match) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return text("Expected a WebSocket upgrade", 426);
      }
      // Checked here so malformed codes never instantiate a Durable Object.
      const code = normalizeRoomCode(decodeURIComponent(match[1] ?? ""));
      if (!code) return text("Invalid room code", 400);
      return env.ROOMS.getByName(code).fetch(request);
    }

    return text("Not found", 404);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
