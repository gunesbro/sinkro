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
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const open: TestClient[] = [];

/**
 * A WebSocket with its incoming frames queued, so tests can read them in order. Lists of the
 * room's people come with most changes, so they have a queue of their own: tests about
 * something else read on as if they weren't there.
 */
class TestClient {
  private readonly frames: string[] = [];
  private frameWaiters: ((frame: string) => void)[] = [];
  private readonly peopleFrames: string[] = [];
  private peopleWaiters: ((frame: string) => void)[] = [];
  readonly closed: Promise<number>;

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const frame = event.data as string;
      const isPeople = frame.startsWith('{"type":"people"');
      const waiter = (isPeople ? this.peopleWaiters : this.frameWaiters).shift();
      if (waiter) waiter(frame);
      else (isPeople ? this.peopleFrames : this.frames).push(frame);
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

  /** The next list of the room's people. */
  async nextPeople(): Promise<{ id: string; name?: string }[]> {
    const queued = this.peopleFrames.shift();
    const frame =
      queued ?? (await new Promise<string>((resolve) => this.peopleWaiters.push(resolve)));
    return (JSON.parse(frame) as { people: { id: string; name?: string }[] }).people;
  }

  /** Skips to the newest list of people that has arrived, after giving the room a moment. */
  async latestPeople(): Promise<{ id: string; name?: string }[]> {
    let latest = await this.nextPeople();
    await new Promise((resolve) => setTimeout(resolve, 50));
    while (this.peopleFrames.length > 0) latest = await this.nextPeople();
    return latest;
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

  it("can be replaced by someone in the room", async () => {
    const code = await createRoom();
    const { client: setter } = await join(code);
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

  it("tells everyone who joined when it changes", async () => {
    const code = await createRoom();
    const { client: viewer } = await join(code);
    const setter = await connect(code);
    setter.send({ type: "video/set", sealed: "abc" });

    expect(await setter.next()).toEqual({ type: "video", sealed: "abc" });
    expect(await viewer.next()).toEqual({ type: "video", sealed: "abc" });
  });

  it("tells a viewer before the state that moves them", async () => {
    const code = await createRoom();
    const { client: first } = await join(code);
    const { client: second } = await join(code);
    await first.next();
    first.send({ type: "video/set", sealed: "abc" });
    first.sendState();

    expect((await second.next()).type).toBe("video");
    expect((await second.next()).type).toBe("state");
  });

  it("answers whoever set it only once", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    client.send({ type: "video/set", sealed: "abc" });
    await client.next();
    client.send({ type: "ping", clientTime: 1 });

    expect((await client.next()).type).toBe("pong");
  });

  it("goes to whoever joins later", async () => {
    const code = await createRoom();
    const setter = await connect(code);
    setter.send({ type: "video/set", sealed: "abc" });
    await setter.next();

    const late = await connect(code);
    late.send({ type: "join", protocol: PROTOCOL_VERSION });
    expect(await late.next()).toMatchObject({ type: "joined", video: "abc" });
  });

  it("isn't mentioned to someone joining a room without one", async () => {
    const code = await createRoom();
    const late = await connect(code);
    late.send({ type: "join", protocol: PROTOCOL_VERSION });
    expect(await late.next()).not.toHaveProperty("video");
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

  it("refuses person 51", async () => {
    const code = await createRoom();
    for (let i = 0; i < 50; i += 1) await join(code);
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

describe("limits", () => {
  const upgrade = (code: string, address: string) =>
    request(`/rooms/${code}/ws`, {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": address },
    });

  it("refuses an address opening too many connections in a minute", async () => {
    const code = await createRoom();
    const address = newAddress();
    for (let i = 0; i < 60; i += 1) {
      const response = await upgrade(code, address);
      expect(response.status).toBe(101);
      new TestClient(response.webSocket as WebSocket).close();
    }
    expect((await upgrade(code, address)).status).toBe(429);
    expect((await upgrade(code, newAddress())).status).toBe(101);
  });

  it("doesn't let sockets that never join crowd people out", async () => {
    const code = await createRoom();
    for (let i = 0; i < 60; i += 1) await connect(code);
    const { client } = await join(code);
    client.send({ type: "ping", clientTime: 1 });
    expect((await client.next()).type).toBe("pong");
  });

  it("only lets someone in the room change its video once it has one", async () => {
    const code = await createRoom();
    const creator = await connect(code);
    creator.send({ type: "video/set", sealed: "first" });
    expect(await creator.next()).toEqual({ type: "video", sealed: "first" });

    const outsider = await connect(code);
    outsider.send({ type: "video/set", sealed: "elsewhere" });
    expect(await outsider.next()).toEqual({ type: "error", code: "not_joined" });

    const { client } = await join(code);
    client.send({ type: "video/set", sealed: "second" });
    expect(await client.next()).toEqual({ type: "video", sealed: "second" });
  });
});

describe("saving states", () => {
  it("keeps every state in order, however quickly they come", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    for (let i = 1; i <= 8; i += 1) a.sendState({ position: i });
    const seqs: number[] = [];
    for (let i = 1; i <= 8; i += 1) seqs.push(((await b.next()) as { seq: number }).seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(8);
  });

  it("gives someone joining the newest state even before it's saved", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    for (let i = 1; i <= 5; i += 1) client.sendState({ position: i * 10 });
    for (let i = 1; i <= 5; i += 1) await client.next();
    const late = await connect(code);
    late.send({ type: "join", protocol: PROTOCOL_VERSION });
    expect(await late.next()).toMatchObject({ state: { position: 50 } });
  });

  it("saves the newest within about a second", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    for (let i = 1; i <= 5; i += 1) client.sendState({ position: i * 10 });
    for (let i = 1; i <= 5; i += 1) await client.next();
    await expect
      .poll(
        () =>
          runInDurableObject(env.ROOMS.getByName(code), async (_, state) => {
            const record = await state.storage.get<{ state: { position: number } }>("room");
            return record?.state.position;
          }),
        { timeout: 3000 },
      )
      .toBe(50);
  });
});

describe("everyone's names", () => {
  it("lists everyone, the newcomer included, as soon as they join", async () => {
    const code = await createRoom();
    const { client: a, clientId: aId } = await join(code);
    expect(await a.nextPeople()).toEqual([{ id: aId }]);
    const { client: b, clientId: bId } = await join(code);

    const ids = (people: { id: string }[]) => people.map((person) => person.id).sort();
    expect(ids(await b.nextPeople())).toEqual([aId, bId].sort());
    expect(ids(await a.latestPeople())).toEqual([aId, bId].sort());
  });

  it("passes a name on as it was sealed, to everyone", async () => {
    const code = await createRoom();
    const { client: a, clientId: aId } = await join(code);
    const { client: b } = await join(code);
    await a.latestPeople();
    await b.latestPeople();
    a.send({ type: "name", sealed: "sealed-name" });

    expect(await b.nextPeople()).toContainEqual({ id: aId, name: "sealed-name" });
    expect(await a.nextPeople()).toContainEqual({ id: aId, name: "sealed-name" });
  });

  it("goes with the id each state carries", async () => {
    const code = await createRoom();
    const { client: a, clientId: aId } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    a.sendState();
    expect(await b.next()).toMatchObject({ type: "state", from: aId });
  });

  it("forgets someone who leaves", async () => {
    const code = await createRoom();
    const { client: a, clientId: aId } = await join(code);
    const { client: b } = await join(code);
    await a.latestPeople();
    b.send({ type: "name", sealed: "b" });
    await a.nextPeople();
    b.close();

    expect(await a.nextPeople()).toEqual([{ id: aId }]);
  });

  it("isn't kept in the room's storage", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    await a.nextPeople();
    a.send({ type: "name", sealed: "sealed-name" });
    await a.nextPeople();

    const stored = await runInDurableObject(env.ROOMS.getByName(code), (_, state) =>
      state.storage.list(),
    );
    expect(JSON.stringify([...stored.values()])).not.toContain("sealed-name");
  });

  it("isn't taken from someone who hasn't joined", async () => {
    const code = await createRoom();
    const client = await connect(code);
    client.send({ type: "name", sealed: "x" });
    expect(await client.next()).toEqual({ type: "error", code: "not_joined" });
  });

  it("refuses one too long to be a name", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    client.send({ type: "name", sealed: "x".repeat(301) });
    expect(await client.next()).toEqual({ type: "error", code: "invalid_message" });
  });
});

describe("everyone's film", () => {
  it("is told to the others, without their own", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    a.send({ type: "film", duration: 1200, source: "sealed" });

    expect(await b.next()).toEqual({
      type: "films",
      films: [{ duration: 1200, source: "sealed", count: 1 }],
    });
    expect(await a.next()).toEqual({ type: "films", films: [] });
  });

  it("counts alike ones together", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    const { client: c } = await join(code);
    await a.next();
    await a.next();
    await b.next();
    b.send({ type: "film", duration: 600.2, source: "s" });
    await a.next();
    c.send({ type: "film", duration: 599.9, source: "s" });

    const message = (await a.next()) as {
      films: { duration: number; source: string; count: number }[];
    };
    expect(message.films).toHaveLength(1);
    expect(message.films[0]).toMatchObject({ source: "s", count: 2 });
    expect(message.films[0]?.duration).toBeCloseTo(600, 0);
  });

  it("forgets someone's film when they leave", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    b.send({ type: "film", duration: 600 });
    await a.next();
    b.close();
    expect(await a.next()).toEqual({ type: "peers", count: 1 });
    expect(await a.next()).toEqual({ type: "films", films: [] });
  });

  it("leaves out someone on an ad, whose player has the ad's length", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    b.send({ type: "film", duration: 1440 });
    expect(await a.next()).toEqual({ type: "films", films: [{ duration: 1440, count: 1 }] });
    b.send({ type: "ad", watching: true });
    expect(await a.next()).toEqual({ type: "ads", count: 1 });
    expect(await a.next()).toEqual({ type: "films", films: [] });
    // An older version tells the room the ad's length; nobody hears of it.
    b.send({ type: "film", duration: 15 });
    expect(await a.next()).toEqual({ type: "films", films: [] });
    b.send({ type: "film", duration: 1440 });
    await a.next();
    b.send({ type: "ad", watching: false });
    expect(await a.next()).toEqual({ type: "ads", count: 0 });
    expect(await a.next()).toEqual({ type: "films", films: [{ duration: 1440, count: 1 }] });
  });

  it("leaves out someone on another page", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    b.send({ type: "film", duration: 600 });
    await a.next();
    b.send({ type: "behind", behind: true });
    expect(await a.next()).toEqual({ type: "left_behind", count: 1 });
    expect(await a.next()).toEqual({ type: "films", films: [] });
  });

  it("is told to someone joining", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    a.send({ type: "film", duration: 900 });
    await a.next();
    const { client: b } = await join(code);
    expect(await b.next()).toEqual({ type: "films", films: [{ duration: 900, count: 1 }] });
  });

  it("needs joining first", async () => {
    const client = await connect(await createRoom());
    client.send({ type: "film", duration: 900 });
    expect(await client.next()).toEqual({ type: "error", code: "not_joined" });
  });
});

describe("actions that cross", () => {
  it("keeps both a pause and a seek sent at once", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    a.send({ type: "state", playing: true, position: 10, rate: 1, sentAt: Date.now() });
    const started = await a.next();
    await b.next();
    expect(started).toMatchObject({ type: "state", seq: 1 });

    // Neither has heard the other's.
    b.send({
      type: "state",
      playing: true,
      position: 600,
      rate: 1,
      sentAt: Date.now(),
      changed: ["position"],
      basis: 1,
    });
    a.send({
      type: "state",
      playing: false,
      position: 12,
      rate: 1,
      sentAt: Date.now(),
      changed: ["playing"],
      basis: 1,
    });
    await a.next();
    await b.next();
    const last = await a.next();
    expect(await b.next()).toEqual(last);
    expect(last).toMatchObject({ type: "state", playing: false, seq: 3 });
    expect((last as { position: number }).position).toBeGreaterThan(599);
  });

  it("lets an old client's state replace the room's, as before", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    a.send({ type: "state", playing: true, position: 10, rate: 1, sentAt: Date.now() });
    await a.next();
    await b.next();
    b.send({ type: "state", playing: false, position: 3, rate: 2, sentAt: Date.now() });
    expect(await a.next()).toMatchObject({ playing: false, position: 3, rate: 2 });
  });
});

describe("the room's spread", () => {
  it("is how far apart the furthest two say they are", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    a.send({ type: "drift", seconds: 0.1 });
    b.send({ type: "drift", seconds: -0.05 });

    expect(await a.next()).toEqual({ type: "spread", seconds: 0.15 });
    expect(await b.next()).toEqual({ type: "spread", seconds: 0.15 });
  });

  it("isn't sent for changes too small to matter", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    a.send({ type: "drift", seconds: 0.1 });
    b.send({ type: "drift", seconds: 0 });
    await a.next();
    await b.next();
    b.send({ type: "drift", seconds: 0.01 });
    a.send({ type: "ping", clientTime: 1 });

    expect((await a.next()).type).toBe("pong");
  });

  it("is told to someone joining later", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    a.send({ type: "drift", seconds: 0.1 });
    b.send({ type: "drift", seconds: 0 });
    await a.next();
    await b.next();
    const { client: c } = await join(code);

    expect(await c.next()).toEqual({ type: "spread", seconds: 0.1 });
  });

  it("starts over once the room moves on", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    a.send({ type: "drift", seconds: 0.1 });
    b.send({ type: "drift", seconds: 0 });
    await a.next();
    await b.next();
    a.send({ type: "state", playing: false, position: 5, rate: 1, sentAt: Date.now() });
    expect((await a.next()).type).toBe("state");
    expect((await b.next()).type).toBe("state");
    a.send({ type: "drift", seconds: 0.02 });
    b.send({ type: "drift", seconds: 0 });

    expect(await a.next()).toEqual({ type: "spread", seconds: 0.02 });
  });

  it("needs joining first", async () => {
    const client = await connect(await createRoom());
    client.send({ type: "drift", seconds: 0.1 });
    expect(await client.next()).toEqual({ type: "error", code: "not_joined" });
  });

  it("refuses a drift that's really a seek", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    client.send({ type: "drift", seconds: 90 });
    expect(await client.next()).toEqual({ type: "error", code: "invalid_message" });
  });
});

describe("a room whose storage fails", () => {
  const breakStorage = (code: string) =>
    runInDurableObject(env.ROOMS.getByName(code), (instance) => {
      const storage = (instance as unknown as { ctx: DurableObjectState }).ctx.storage;
      storage.put = () => Promise.reject(new Error("quota"));
    });

  it("still passes states on and echoes them, so nobody waits for good", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    await breakStorage(code);
    a.sendState({ position: 77 });

    expect(await b.next()).toMatchObject({ type: "state", position: 77 });
    expect(await a.next()).toMatchObject({ type: "state", position: 77 });
  });

  it("answers with an error when it can't do what was asked", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    await breakStorage(code);
    client.send({ type: "video/set", sealed: "abc" });

    expect(await client.next()).toEqual({ type: "error", code: "server_error" });
  });
});

describe("a state's film details", () => {
  it("reach the others and whoever joins later", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    a.sendState({ duration: 1471, source: "sealed" });

    expect(await b.next()).toMatchObject({ type: "state", duration: 1471, source: "sealed" });
    const late = await connect(code);
    late.send({ type: "join", protocol: PROTOCOL_VERSION });
    expect(await late.next()).toMatchObject({ state: { duration: 1471, source: "sealed" } });
  });
});

describe("moving the room to a different film", () => {
  const stateAt = async (code: string) => {
    const late = await connect(code);
    late.send({ type: "join", protocol: PROTOCOL_VERSION });
    return ((await late.next()) as { state: unknown }).state;
  };

  it("forgets the old film's position", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    client.sendState();
    await client.next();
    client.send({ type: "video/set", sealed: "new", fresh: true });
    await client.next();

    expect(await stateAt(code)).toBeNull();
  });

  it("keeps it when it's the same film", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    client.sendState();
    await client.next();
    client.send({ type: "video/set", sealed: "same" });
    await client.next();

    expect(await stateAt(code)).not.toBeNull();
  });

  it("tells the others to forget it", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    a.send({ type: "video/set", sealed: "new", fresh: true });

    expect(await b.next()).toEqual({ type: "video", sealed: "new", fresh: true });
  });

  it("doesn't tell the one moving it, whose position is already the new one", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    client.send({ type: "video/set", sealed: "new", fresh: true });

    expect(await client.next()).toEqual({ type: "video", sealed: "new" });
  });

  it("keeps counting from where it was, so newer states still win", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    client.sendState();
    const first = (await client.next()) as { seq: number };
    client.send({ type: "video/set", sealed: "new", fresh: true });
    await client.next();
    client.sendState();
    const next = (await client.next()) as { seq: number };

    expect(next.seq).toBeGreaterThan(first.seq);
  });
});

describe("a viewer reconnecting", () => {
  const joinAs = async (code: string, viewer?: string) => {
    const client = await connect(code);
    client.send({ type: "join", protocol: PROTOCOL_VERSION, ...(viewer ? { viewer } : {}) });
    return { client, joined: (await client.next()) as { peers: number } };
  };

  it("isn't counted twice while the old socket still looks open", async () => {
    const code = await createRoom();
    const { client: other } = await joinAs(code, "other");
    await joinAs(code, "me");
    expect(await other.next()).toEqual({ type: "peers", count: 2 });

    const { joined } = await joinAs(code, "me");
    expect(joined.peers).toBe(2);
    expect(await other.next()).toEqual({ type: "peers", count: 2 });
  });

  it("closes the old socket", async () => {
    const code = await createRoom();
    const { client: old } = await joinAs(code, "me");
    await joinAs(code, "me");
    expect(await old.closed).toBe(1000);
  });

  it("keeps different viewers apart", async () => {
    const code = await createRoom();
    await joinAs(code, "me");
    const { joined } = await joinAs(code, "you");
    expect(joined.peers).toBe(2);
  });

  it("leaves alone clients that don't say who they are", async () => {
    const code = await createRoom();
    await joinAs(code);
    const { joined } = await joinAs(code);
    expect(joined.peers).toBe(2);
  });

  it("stops counting the old socket's ad", async () => {
    const code = await createRoom();
    const { client: other } = await joinAs(code, "other");
    const { client: old } = await joinAs(code, "me");
    await other.next();
    old.send({ type: "ad", watching: true });
    expect(await other.next()).toEqual({ type: "ads", count: 1 });

    await joinAs(code, "me");
    expect(await other.next()).toEqual({ type: "peers", count: 2 });
    expect(await other.next()).toEqual({ type: "ads", count: 0 });
  });

  it("keeps who it is after saying it's on an ad", async () => {
    const code = await createRoom();
    const { client: first } = await joinAs(code, "me");
    first.send({ type: "ad", watching: true });
    await first.next();
    const { joined } = await joinAs(code, "me");
    expect(joined.peers).toBe(1);
  });

  it("doesn't store who it is", async () => {
    const code = await createRoom();
    await joinAs(code, "me-secret");
    const stored = await runInDurableObject(env.ROOMS.getByName(code), (_, state) =>
      state.storage.get("room"),
    );
    expect(JSON.stringify(stored)).not.toContain("me-secret");
  });
});

describe("someone who hasn't come to the room's video", () => {
  it("is counted for the others, and not told about themselves", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    b.send({ type: "behind", behind: true });

    expect(await a.next()).toEqual({ type: "left_behind", count: 1 });
    expect(await b.next()).toEqual({ type: "left_behind", count: 0 });
  });

  it("stops being counted on arriving, or on leaving", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    const { client: c } = await join(code);
    await a.next();
    await a.next();
    await b.next();
    b.send({ type: "behind", behind: true });
    c.send({ type: "behind", behind: true });
    expect(await a.next()).toEqual({ type: "left_behind", count: 1 });
    expect(await a.next()).toEqual({ type: "left_behind", count: 2 });
    b.send({ type: "behind", behind: false });
    expect(await a.next()).toEqual({ type: "left_behind", count: 1 });
    c.close();
    expect(await a.next()).toEqual({ type: "peers", count: 2 });
    expect(await a.next()).toEqual({ type: "left_behind", count: 0 });
  });

  it("is told to someone joining", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    a.send({ type: "behind", behind: true });
    await a.next();
    const { client: b } = await join(code);
    expect(await b.next()).toEqual({ type: "left_behind", count: 1 });
  });

  it("needs joining first", async () => {
    const client = await connect(await createRoom());
    client.send({ type: "behind", behind: true });
    expect(await client.next()).toEqual({ type: "error", code: "not_joined" });
  });
});

describe("someone on an ad", () => {
  it("tells the others, and not them", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    a.send({ type: "ad", watching: true });

    expect(await b.next()).toEqual({ type: "ads", count: 1 });
    expect(await a.next()).toEqual({ type: "ads", count: 0 });
  });

  it("counts them", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    const { client: c } = await join(code);
    await a.next();
    await a.next();
    await b.next();
    a.send({ type: "ad", watching: true });
    expect(await c.next()).toEqual({ type: "ads", count: 1 });
    b.send({ type: "ad", watching: true });
    expect(await c.next()).toEqual({ type: "ads", count: 2 });
  });

  it("says when it ends", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    a.send({ type: "ad", watching: true });
    await b.next();
    a.send({ type: "ad", watching: false });

    expect(await b.next()).toEqual({ type: "ads", count: 0 });
  });

  it("says nothing when nothing changed", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    a.send({ type: "ad", watching: false });
    a.sendState();

    expect((await b.next()).type).toBe("state");
  });

  it("ends when they leave", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    const { client: b } = await join(code);
    await a.next();
    a.send({ type: "ad", watching: true });
    await b.next();
    a.close();

    expect(await b.next()).toEqual({ type: "peers", count: 1 });
    expect(await b.next()).toEqual({ type: "ads", count: 0 });
  });

  it("is told to whoever joins meanwhile", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    a.send({ type: "ad", watching: true });
    await a.next();

    const late = await connect(code);
    late.send({ type: "join", protocol: PROTOCOL_VERSION });
    expect(await late.next()).toMatchObject({ type: "joined", ads: 1 });
  });

  it("isn't mentioned to someone joining a room with no ads", async () => {
    const code = await createRoom();
    const late = await connect(code);
    late.send({ type: "join", protocol: PROTOCOL_VERSION });
    expect(await late.next()).not.toHaveProperty("ads");
  });

  it("isn't stored", async () => {
    const code = await createRoom();
    const { client: a } = await join(code);
    a.send({ type: "ad", watching: true });
    await a.next();

    const stored = await runInDurableObject(env.ROOMS.getByName(code), (_, state) =>
      state.storage.get("room"),
    );
    expect(JSON.stringify(stored)).not.toContain("onAd");
  });

  it("needs joining first", async () => {
    const client = await connect(await createRoom());
    client.send({ type: "ad", watching: true });
    expect(await client.next()).toEqual({ type: "error", code: "not_joined" });
  });
});

describe("a room nothing is happening in", () => {
  const activeAgo = (code: string, ms: number) =>
    runInDurableObject(env.ROOMS.getByName(code), async (_, state) => {
      const record = await state.storage.get<object>("room");
      await state.storage.put("room", { ...record, activeAt: Date.now() - ms });
    });
  const check = (code: string) => runDurableObjectAlarm(env.ROOMS.getByName(code));

  it("closes after 12 hours, saying why", async () => {
    const code = await createRoom();
    const a = await join(code);
    const b = await join(code);
    await activeAgo(code, 12 * HOUR_MS + 1);
    await check(code);

    expect(await a.client.closed).toBe(CloseCode.RoomIdle);
    expect(await b.client.closed).toBe(CloseCode.RoomIdle);
  });

  it("takes everything it held with it", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    client.send({ type: "video/set", sealed: "abc" });
    await client.next();
    await activeAgo(code, 12 * HOUR_MS + 1);
    await check(code);
    await client.closed;

    expect(await runInDurableObject(env.ROOMS.getByName(code), (_, s) => s.storage.list())).toEqual(
      new Map(),
    );
    const late = await connect(code);
    expect(await late.closed).toBe(CloseCode.RoomNotFound);
  });

  it("stays open before that, and checks again later", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    await activeAgo(code, 11 * HOUR_MS);
    await check(code);

    expect(await getAlarm(code)).toBeGreaterThan(Date.now());
    client.send({ type: "ping", clientTime: 1 });
    expect((await client.next()).type).toBe("pong");
  });

  it("counts a change of playback as something happening", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    await activeAgo(code, 12 * HOUR_MS + 1);
    client.sendState();
    await client.next();
    await check(code);

    client.send({ type: "ping", clientTime: 1 });
    expect((await client.next()).type).toBe("pong");
  });

  it("counts moving the room to another video", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    await activeAgo(code, 12 * HOUR_MS + 1);
    client.send({ type: "video/set", sealed: "abc" });
    await client.next();
    await check(code);

    client.send({ type: "ping", clientTime: 1 });
    expect((await client.next()).type).toBe("pong");
  });

  it("counts someone joining", async () => {
    const code = await createRoom();
    const a = await join(code);
    await activeAgo(code, 12 * HOUR_MS + 1);
    await join(code);
    await a.client.next();
    await check(code);

    a.client.send({ type: "ping", clientTime: 1 });
    expect((await a.client.next()).type).toBe("pong");
  });

  it("doesn't count keeping the connection alive", async () => {
    const code = await createRoom();
    const { client } = await join(code);
    await activeAgo(code, 12 * HOUR_MS + 1);
    client.send("keepalive");
    expect(await client.nextFrame()).toBe("keepalive");
    await check(code);

    expect(await client.closed).toBe(CloseCode.RoomIdle);
  });
});

describe("expiry", () => {
  it("schedules a room nobody joins for deletion", async () => {
    const before = Date.now();
    const alarm = await getAlarm(await createRoom());
    expect(alarm).toBeGreaterThanOrEqual(before + DAY_MS - 5000);
  });

  it("puts off the deletion while someone is in the room", async () => {
    const code = await createRoom();
    await join(code);
    expect(await getAlarm(code)).toBeLessThan(Date.now() + 2 * HOUR_MS);
    expect(await runDurableObjectAlarm(env.ROOMS.getByName(code))).toBe(true);
    const late = await connect(code);
    late.send({ type: "join", protocol: PROTOCOL_VERSION });
    expect((await late.next()).type).toBe("joined");
  });

  it("schedules deletion when the last person leaves, and only then", async () => {
    const code = await createRoom();
    const a = await join(code);
    const b = await join(code);
    await a.client.next();

    b.client.close();
    await a.client.next();
    expect(await getAlarm(code)).toBeLessThan(Date.now() + 2 * HOUR_MS);

    a.client.close();
    await expect.poll(() => getAlarm(code)).toBeGreaterThan(Date.now() + 23 * HOUR_MS);
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
