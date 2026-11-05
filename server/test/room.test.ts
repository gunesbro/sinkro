import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import {
  CloseCode,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "../src/protocol";

const BASE = "https://sinkro.test";
const DAY_MS = 24 * 60 * 60 * 1000;
const open: TestClient[] = [];

/** A WebSocket with its incoming frames queued, so tests can read them in order. */
class TestClient {
  private readonly frames: string[] = [];
  private frameWaiters: ((frame: string) => void)[] = [];
  readonly closed: Promise<number>;

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const frame = event.data as string;
      const waiter = this.frameWaiters.shift();
      if (waiter) waiter(frame);
      else this.frames.push(frame);
    });
    this.closed = new Promise((resolve) => {
      socket.addEventListener("close", (event) => resolve(event.code));
    });
    socket.accept();
    open.push(this);
  }

  nextFrame(): Promise<string> {
    const queued = this.frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.frameWaiters.push(resolve));
  }

  async next(): Promise<ServerMessage> {
    return JSON.parse(await this.nextFrame()) as ServerMessage;
  }

  send(message: unknown): void {
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  sendState(overrides: object = {}): void {
    this.send({
      type: "state",
      playing: true,
      position: 42,
      rate: 1,
      sentAt: Date.now(),
      ...overrides,
    });
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000);
  }
}

function request(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

let nextAddress = 0;

/** Each test client looks like a different person, so the creation limit stays out of the way. */
function newAddress(): string {
  nextAddress += 1;
  return `192.0.2.${nextAddress}`;
}

function createFrom(address: string): Promise<Response> {
  return request("/rooms", { method: "POST", headers: { "CF-Connecting-IP": address } });
}

async function createRoom(): Promise<string> {
  const response = await createFrom(newAddress());
  expect(response.status).toBe(201);
  return ((await response.json()) as { code: string }).code;
}

async function connect(code: string): Promise<TestClient> {
  const response = await request(`/rooms/${code}/ws`, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  return new TestClient(response.webSocket as WebSocket);
}

async function join(code: string): Promise<{ client: TestClient; clientId: string }> {
  const client = await connect(code);
  client.send({ type: "join", protocol: 1 });
  const joined = await client.next();
  if (joined.type !== "joined") throw new Error(`Expected joined, got ${joined.type}`);
  return { client, clientId: joined.clientId };
}

function getAlarm(code: string): Promise<number | null> {
  return runInDurableObject(env.ROOMS.getByName(code), (_, state) => state.storage.getAlarm());
}

afterEach(async () => {
  for (const client of open.splice(0)) client.close();
});

describe("the room's video", () => {
  const videoOf = async (code: string) => {
    const client = await connect(code);
    client.send({ type: "video/get" });
    return client.next();
  };

  it("starts with none", async () => {
    expect(await videoOf(await createRoom())).toEqual({ type: "video", sealed: null });
  });

  it("is kept for whoever asks later, without anyone joining", async () => {
    const code = await createRoom();
    const setter = await connect(code);
    setter.send({ type: "video/set", sealed: "abc" });
    expect(await setter.next()).toEqual({ type: "video", sealed: "abc" });
    setter.close();

    expect(await videoOf(code)).toEqual({ type: "video", sealed: "abc" });
  });

  it("can be replaced", async () => {
    const code = await createRoom();
    const setter = await connect(code);
    setter.send({ type: "video/set", sealed: "one" });
    await setter.next();
    setter.send({ type: "video/set", sealed: "two" });
    await setter.next();

    expect(await videoOf(code)).toEqual({ type: "video", sealed: "two" });
  });

  it("survives playback changes", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    client.send({ type: "video/set", sealed: "abc" });
    await client.next();
    client.sendState();
    await client.next();

    expect(await videoOf(code)).toEqual({ type: "video", sealed: "abc" });
  });

  it("doesn't count anyone asking as a person in the room", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    await videoOf(code);
    const other = await join(code);

    const peers = await client.next();
    expect(peers).toEqual({ type: "peers", count: 2 });
    other.client.close();
  });

  it("goes when the room does", async () => {
    const code = await createRoom();
    const setter = await connect(code);
    setter.send({ type: "video/set", sealed: "abc" });
    await setter.next();
    setter.close();

    const room = env.ROOMS.getByName(code);
    await expect
      .poll(async () => {
        await runDurableObjectAlarm(room);
        return (await runInDurableObject(room, (_, state) => state.storage.list())).size;
      })
      .toBe(0);
  });

  it("tells someone asking about a room that doesn't exist", async () => {
    const client = await connect("K7M-2QX");
    expect(await client.closed).toBe(CloseCode.RoomNotFound);
  });
});

describe("protocol versions", () => {
  it.each([
    ["newer than the server knows", PROTOCOL_VERSION + 1],
    ["older than it still supports", MIN_PROTOCOL_VERSION - 1],
  ])("refuses a client %s", async (_, protocol) => {
    const client = await connect(await createRoom());
    client.send({ type: "join", protocol });
    expect(await client.closed).toBe(CloseCode.ProtocolMismatch);
  });

  it("accepts the oldest supported version", async () => {
    const client = await connect(await createRoom());
    client.send({ type: "join", protocol: MIN_PROTOCOL_VERSION });
    expect((await client.next()).type).toBe("joined");
  });

  it("lets a client send fields it knows and the server doesn't", async () => {
    const code = await createRoom();
    const { client: newer } = await join(code);
    const { client: older } = await join(code);
    await newer.next();
    newer.sendState({ position: 7, somethingNew: true });

    const received = await older.next();
    expect(received).toMatchObject({ type: "state", position: 7 });
    expect(received).not.toHaveProperty("somethingNew");
  });
});

describe("HTTP routes", () => {
  it("reports health", async () => {
    const response = await request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("returns 404 for unknown paths", async () => {
    expect((await request("/nope")).status).toBe(404);
  });

  it("answers CORS preflight and allows any origin", async () => {
    const preflight = await request("/rooms", { method: "OPTIONS" });
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const created = await createFrom(newAddress());
    expect(created.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("limits how many rooms one address can create", async () => {
    const address = newAddress();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      statuses.push((await createFrom(address)).status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("answers a refused creation so a page can read it", async () => {
    const address = newAddress();
    let refused: Response | null = null;
    for (let attempt = 0; attempt < 12 && !refused; attempt += 1) {
      const response = await createFrom(address);
      if (response.status === 429) refused = response;
    }
    expect(refused?.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("doesn't let one address's limit affect another", async () => {
    const address = newAddress();
    for (let attempt = 0; attempt < 12; attempt += 1) await createFrom(address);
    expect((await createFrom(newAddress())).status).toBe(201);
  });

  it("starts over when the window ends, and keeps nothing after it", async () => {
    const address = newAddress();
    for (let attempt = 0; attempt < 11; attempt += 1) await createFrom(address);
    expect((await createFrom(address)).status).toBe(429);

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
    const name = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const limiter = env.CREATION_LIMITERS.getByName(name);
    expect(await runDurableObjectAlarm(limiter)).toBe(true);
    const stored = await runInDurableObject(limiter, (_, state) => state.storage.list());
    expect(stored.size).toBe(0);

    expect((await createFrom(address)).status).toBe(201);
  });

  it("doesn't count joining against the limit", async () => {
    const code = await createRoom();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const { client } = await join(code);
      client.close();
    }
  });

  it("only creates rooms with POST", async () => {
    expect((await request("/rooms")).status).toBe(405);
  });

  it("requires a WebSocket upgrade", async () => {
    expect((await request(`/rooms/${await createRoom()}/ws`)).status).toBe(426);
  });

  it("rejects malformed codes without touching a room", async () => {
    const response = await request("/rooms/bad!code/ws", { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(400);
  });

  it("doesn't let a room be created twice", async () => {
    const code = await createRoom();
    expect(await env.ROOMS.getByName(code).create()).toBe(false);
  });
});

describe("joining", () => {
  it("creates a code in the design's format", async () => {
    expect(await createRoom()).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  });

  it("refuses a room that doesn't exist", async () => {
    const client = await connect("K7M-2QX");
    expect(await client.closed).toBe(CloseCode.RoomNotFound);
  });

  it("refuses a different protocol version", async () => {
    const client = await connect(await createRoom());
    client.send({ type: "join", protocol: 999 });
    expect(await client.closed).toBe(CloseCode.ProtocolMismatch);
  });

  it("reaches the same room with a lowercase code and no dash", async () => {
    const code = await createRoom();
    const { client: first } = await join(code);
    const second = await connect(code.toLowerCase().replace("-", ""));
    second.send({ type: "join", protocol: 1 });
    expect(await second.next()).toMatchObject({ type: "joined", peers: 2 });
    expect(await first.next()).toEqual({ type: "peers", count: 2 });
  });

  it("gives each person a different id and tells the others about arrivals and departures", async () => {
    const code = await createRoom();
    const a = await join(code);
    const b = await join(code);
    expect(a.clientId).not.toBe(b.clientId);
    expect(await a.client.next()).toEqual({ type: "peers", count: 2 });

    b.client.close();
    expect(await a.client.next()).toEqual({ type: "peers", count: 1 });
  });

  it("ignores a repeated join", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    client.send({ type: "join", protocol: 1 });
    client.send({ type: "ping", clientTime: 1 });
    expect((await client.next()).type).toBe("pong");
  });

  it("refuses connection 51", async () => {
    const code = await createRoom();
    for (let i = 0; i < 50; i += 1) await connect(code);
    const extra = await connect(code);
    expect(await extra.closed).toBe(CloseCode.RoomFull);
  });
});

describe("playback state", () => {
  it("reaches everyone in a room of 12, including the sender", async () => {
    const code = await createRoom();
    const people = [];
    for (let i = 0; i < 12; i += 1) people.push(await join(code));

    const sentAt = Date.now();
    people[0]!.client.sendState({ position: 100, rate: 1.5, playing: false, sentAt });

    for (const [index, { client }] of people.entries()) {
      // Earlier joiners first receive one peers message per later arrival.
      for (let i = index + 1; i < people.length; i += 1) await client.next();
      expect(await client.next()).toEqual({
        type: "state",
        playing: false,
        position: 100,
        rate: 1.5,
        sentAt,
        seq: 1,
        from: people[0]!.clientId,
      });
    }
  });

  it("numbers states in the order the room received them", async () => {
    const { client } = await join(await createRoom());
    client.sendState({ position: 1 });
    client.sendState({ position: 2 });
    expect(await client.next()).toMatchObject({ seq: 1, position: 1 });
    expect(await client.next()).toMatchObject({ seq: 2, position: 2 });
  });

  it("gives someone joining late the current state", async () => {
    const code = await createRoom();
    const { client: first, clientId } = await join(code);
    first.sendState({ position: 321 });
    await first.next();

    const late = await connect(code);
    late.send({ type: "join", protocol: 1 });
    expect(await late.next()).toMatchObject({
      type: "joined",
      peers: 2,
      state: { position: 321, seq: 1, from: clientId },
    });
  });

  it("replaces a timestamp that is too far from server time", async () => {
    const { client } = await join(await createRoom());
    const before = Date.now();
    client.sendState({ sentAt: before + 60 * 60 * 1000 });
    const message = await client.next();
    expect(message.type === "state" && Math.abs(message.sentAt - before)).toBeLessThan(5000);
  });

  it("keeps a timestamp within tolerance, so latency can be compensated", async () => {
    const { client } = await join(await createRoom());
    const sentAt = Date.now() - 5000;
    client.sendState({ sentAt });
    expect(await client.next()).toMatchObject({ sentAt });
  });

  it("requires joining first", async () => {
    const client = await connect(await createRoom());
    client.sendState();
    expect(await client.next()).toEqual({ type: "error", code: "not_joined" });
  });

  it("doesn't deliver state to someone who hasn't joined", async () => {
    const code = await createRoom();
    const lurker = await connect(code);
    const { client } = await join(code);
    client.sendState();
    await client.next();
    lurker.send({ type: "ping", clientTime: 1 });
    expect((await lurker.next()).type).toBe("pong");
  });

  it("reports malformed messages and leaves the state alone", async () => {
    const { client } = await join(await createRoom());
    client.send("{");
    expect(await client.next()).toEqual({ type: "error", code: "invalid_message" });
    client.sendState({ rate: 0 });
    expect(await client.next()).toEqual({ type: "error", code: "invalid_message" });
    client.sendState();
    expect(await client.next()).toMatchObject({ seq: 1 });
  });
});

describe("clock and limits", () => {
  it("echoes the client time with the server time, before joining too", async () => {
    const client = await connect(await createRoom());
    const before = Date.now();
    client.send({ type: "ping", clientTime: 12345 });
    const pong = await client.next();
    expect(pong).toMatchObject({ type: "pong", clientTime: 12345 });
    expect(pong.type === "pong" && pong.serverTime).toBeGreaterThanOrEqual(before);
  });

  it("stops handling messages past the limit", async () => {
    const client = await connect(await createRoom());
    for (let i = 0; i < 51; i += 1) client.send({ type: "ping", clientTime: i });
    for (let i = 0; i < 50; i += 1) expect((await client.next()).type).toBe("pong");
    expect(await client.next()).toEqual({ type: "error", code: "rate_limited" });
  });
});

describe("hibernation", () => {
  it("keeps sockets, ids and state when the room is evicted from memory", async () => {
    const code = await createRoom();
    const a = await join(code);
    const b = await join(code);
    await a.client.next();
    a.client.sendState({ position: 10 });
    await a.client.next();
    await b.client.next();

    await evictDurableObject(env.ROOMS.getByName(code));

    b.client.sendState({ position: 20 });
    expect(await a.client.next()).toMatchObject({ seq: 2, position: 20, from: b.clientId });
    expect(await b.client.next()).toMatchObject({ seq: 2, position: 20, from: b.clientId });

    b.client.close();
    expect(await a.client.next()).toEqual({ type: "peers", count: 1 });
  });

  it("answers keepalive after eviction", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    await evictDurableObject(env.ROOMS.getByName(code));
    client.send("keepalive");
    expect(await client.nextFrame()).toBe("keepalive");
  });
});

describe("expiry", () => {
  it("schedules a room nobody joins for deletion", async () => {
    const before = Date.now();
    const alarm = await getAlarm(await createRoom());
    expect(alarm).toBeGreaterThanOrEqual(before + DAY_MS - 5000);
  });

  it("cancels the deletion while someone is in the room", async () => {
    const code = await createRoom();
    await join(code);
    expect(await getAlarm(code)).toBeNull();
  });

  it("schedules deletion when the last person leaves, and only then", async () => {
    const code = await createRoom();
    const a = await join(code);
    const b = await join(code);
    await a.client.next();

    b.client.close();
    await a.client.next();
    expect(await getAlarm(code)).toBeNull();

    a.client.close();
    await expect.poll(() => getAlarm(code)).toBeGreaterThan(Date.now());
  });

  it("deletes an expired room so its code stops working", async () => {
    const code = await createRoom();
    expect(await runDurableObjectAlarm(env.ROOMS.getByName(code))).toBe(true);
    const client = await connect(code);
    expect(await client.closed).toBe(CloseCode.RoomNotFound);
  });

  it("frees the code for a new room", async () => {
    const code = await createRoom();
    await runDurableObjectAlarm(env.ROOMS.getByName(code));
    expect(await env.ROOMS.getByName(code).create()).toBe(true);
  });
});
