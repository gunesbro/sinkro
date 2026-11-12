import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerClock } from "../src/content/sync/clock";
import { RoomConnection, type SocketLike } from "../src/content/sync/connection";

const OPEN = 1;
const CLOSED = 3;

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closedByClient = false;
  private listeners: Record<string, ((event: never) => void)[]> = {};

  addEventListener(type: string, listener: (event: never) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closedByClient = true;
    this.readyState = CLOSED;
    this.fire("close", { code: 1000 });
  }

  fire(type: string, event: unknown = {}): void {
    for (const listener of this.listeners[type] ?? []) listener(event as never);
  }

  open(): void {
    this.readyState = OPEN;
    this.fire("open");
  }

  receive(message: unknown): void {
    this.fire("message", {
      data: typeof message === "string" ? message : JSON.stringify(message),
    });
  }

  drop(code = 1006): void {
    this.readyState = CLOSED;
    this.fire("close", { code });
  }

  messages(): Record<string, unknown>[] {
    return this.sent.filter((m) => m !== "keepalive").map((m) => JSON.parse(m));
  }

  ofType(type: string): Record<string, unknown>[] {
    return this.messages().filter((m) => m.type === type);
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const refusal = { on: false };
  const clock = new ServerClock();
  const events = {
    onJoined: vi.fn(),
    onState: vi.fn(),
    onPeers: vi.fn(),
    onRejected: vi.fn(),
    onVideo: vi.fn(),
    onAds: vi.fn(),
    onSpread: vi.fn(),
    onLeftBehind: vi.fn(),
    onFilms: vi.fn(),
    onPeople: vi.fn(),
    onReaction: vi.fn(),
    onDisconnected: vi.fn(),
    onStatus: vi.fn(),
  };
  const connection = new RoomConnection({
    url: "ws://server/rooms/K7M-2QX/ws",
    clock,
    events,
    createSocket: () => {
      // As a browser does for an address it won't open, like ws:// from an https page.
      if (refusal.on) throw new DOMException("Refused", "SecurityError");
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const latest = () => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error("no socket yet");
    return socket;
  };
  /** Answers pings, as the room would, until the client joins. */
  const handshake = (socket = latest(), extra: object = {}) => {
    socket.open();
    let answered = 0;
    for (const ping of socket.ofType("ping")) {
      answered += 1;
      socket.receive({ type: "pong", clientTime: ping.clientTime, serverTime: Date.now() });
    }
    while (socket.ofType("ping").length > answered) {
      const ping = socket.ofType("ping")[answered];
      answered += 1;
      socket.receive({ type: "pong", clientTime: ping?.clientTime, serverTime: Date.now() });
    }
    socket.receive({ type: "joined", clientId: "me", state: null, peers: 1, ...extra });
  };
  return { connection, sockets, clock, events, latest, handshake, refusal };
}

const playback = { playing: true, position: 1, rate: 1, sentAt: 2 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("joining", () => {
  it("measures the clock before joining", () => {
    const { connection, latest, clock } = setup();
    connection.start();
    const socket = latest();
    socket.open();
    expect(socket.ofType("join")).toEqual([]);

    for (let answered = 0; answered < 3; answered += 1) {
      expect(socket.ofType("ping")).toHaveLength(answered + 1);
      const ping = socket.ofType("ping")[answered];
      socket.receive({ type: "pong", clientTime: ping?.clientTime, serverTime: Date.now() + 700 });
    }

    expect(socket.ofType("join")).toMatchObject([{ type: "join", protocol: 1 }]);
    expect(clock.offset).toBe(700);
  });

  it("joins anyway if pongs never come", () => {
    const { connection, latest } = setup();
    connection.start();
    latest().open();
    vi.advanceTimersByTime(3000);

    expect(latest().ofType("join")).toHaveLength(1);
  });

  it("joins only once, even if a pong arrives after the timeout", () => {
    const { connection, latest } = setup();
    connection.start();
    const socket = latest();
    socket.open();
    vi.advanceTimersByTime(3000);
    socket.receive({ type: "pong", clientTime: Date.now(), serverTime: Date.now() });

    expect(socket.ofType("join")).toHaveLength(1);
  });

  it("reports what the room says", () => {
    const { connection, handshake, events } = setup();
    connection.start();
    handshake();

    expect(events.onStatus).toHaveBeenLastCalledWith("connected", null);
    expect(events.onJoined).toHaveBeenCalledWith({
      type: "joined",
      clientId: "me",
      state: null,
      peers: 1,
    });
  });
});

describe("messages", () => {
  it("passes on states and peer counts", () => {
    const { connection, handshake, latest, events } = setup();
    connection.start();
    handshake();
    const state = { ...playback, seq: 1, from: "peer" };
    latest().receive({ type: "state", ...state });
    latest().receive({ type: "peers", count: 3 });

    expect(events.onState).toHaveBeenCalledWith({ type: "state", ...state });
    expect(events.onPeers).toHaveBeenCalledWith(3);
  });

  it.each([
    ["broken JSON", "{"],
    ["a NaN-like position", { type: "state", ...playback, position: "NaN", seq: 1, from: "x" }],
    ["an unknown type", { type: "surprise" }],
  ])("ignores %s", (_, message) => {
    const { connection, handshake, latest, events } = setup();
    connection.start();
    handshake();
    latest().receive(message);

    expect(events.onState).not.toHaveBeenCalled();
  });

  it("passes on the room's people, and sends a name only once joined", () => {
    const { connection, events, latest, handshake } = setup();
    connection.start();
    latest().open();
    expect(connection.sendName("sealed")).toBe(false);
    handshake();
    latest().receive({ type: "people", people: [{ id: "me" }, { id: "b", name: "x" }] });

    expect(events.onPeople).toHaveBeenCalledWith([{ id: "me" }, { id: "b", name: "x" }]);
    expect(connection.sendName("sealed")).toBe(true);
    expect(latest().ofType("name")).toEqual([{ type: "name", sealed: "sealed" }]);
  });

  it("reports a refused message", () => {
    const { connection, handshake, latest, events } = setup();
    connection.start();
    handshake();
    latest().receive({ type: "error", code: "rate_limited" });

    expect(events.onRejected).toHaveBeenCalled();
  });

  it("only sends states after joining", () => {
    const { connection, handshake, latest } = setup();
    connection.start();
    expect(connection.sendState(playback)).toBe(false);

    latest().open();
    expect(connection.sendState(playback)).toBe(false);
    expect(latest().ofType("state")).toEqual([]);

    handshake();
    expect(connection.sendState(playback)).toBe(true);
    expect(latest().ofType("state")).toEqual([{ type: "state", ...playback }]);
  });
});

describe("closing", () => {
  it.each([
    [4404, "room_not_found"],
    [4409, "room_full"],
    [4408, "room_idle"],
    [4400, "protocol_mismatch"],
  ])("gives up on close code %i", (code, reason) => {
    const { connection, sockets, latest, events } = setup();
    connection.start();
    latest().open();
    latest().drop(code);
    vi.advanceTimersByTime(120_000);

    expect(events.onStatus).toHaveBeenLastCalledWith("closed", reason);
    expect(sockets).toHaveLength(1);
  });

  it("stays closed when stopped", () => {
    const { connection, handshake, sockets, latest, events } = setup();
    connection.start();
    handshake();
    connection.stop();
    vi.advanceTimersByTime(120_000);

    expect(latest().closedByClient).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(events.onStatus).not.toHaveBeenCalledWith("reconnecting", null);
  });
});

describe("reconnecting", () => {
  it("keeps going when the browser refuses to open the socket at all", () => {
    const { connection, handshake, sockets, events, refusal } = setup();
    refusal.on = true;
    expect(() => connection.start()).not.toThrow();
    expect(events.onStatus).toHaveBeenLastCalledWith("reconnecting", null);

    // Refused again on the next try, which mustn't end the trying.
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(0);
    refusal.on = false;
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(1);
    handshake();
    expect(events.onStatus).toHaveBeenLastCalledWith("connected", null);
  });

  it("tells the engine, then comes back and joins again", () => {
    const { connection, handshake, sockets, latest, events } = setup();
    connection.start();
    handshake();
    latest().drop();

    expect(events.onDisconnected).toHaveBeenCalledTimes(1);
    expect(events.onStatus).toHaveBeenLastCalledWith("reconnecting", null);

    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    handshake();
    expect(events.onJoined).toHaveBeenCalledTimes(2);
    expect(events.onStatus).toHaveBeenLastCalledWith("connected", null);
  });

  it("backs off, up to a limit", () => {
    const { connection, sockets, latest } = setup();
    connection.start();
    const gaps: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const count = sockets.length;
      latest().drop();
      let waited = 0;
      while (sockets.length === count) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      gaps.push(waited);
    }

    expect(gaps[0]).toBeLessThanOrEqual(1000);
    expect(gaps[3]).toBeGreaterThanOrEqual(4000);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(30_000);
  });

  it("starts the backoff over after a successful join", () => {
    const { connection, handshake, sockets, latest } = setup();
    connection.start();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      latest().drop();
      vi.advanceTimersByTime(30_000);
    }
    handshake();
    const count = sockets.length;
    latest().drop();
    vi.advanceTimersByTime(1000);

    expect(sockets).toHaveLength(count + 1);
  });

  it("skips the wait when the network comes back", () => {
    const { connection, sockets, latest } = setup();
    connection.start();
    latest().drop();
    connection.retryNow();

    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
  });

  it("does nothing extra if asked to retry while connected", () => {
    const { connection, handshake, sockets } = setup();
    connection.start();
    handshake();
    connection.retryNow();

    expect(sockets).toHaveLength(1);
  });

  it("ignores a socket it has already replaced", () => {
    const { connection, handshake, sockets, latest, events } = setup();
    connection.start();
    handshake();
    const old = latest();
    old.drop();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);

    old.receive({ type: "state", ...playback, seq: 1, from: "peer" });
    old.drop();

    expect(events.onState).not.toHaveBeenCalled();
    expect(events.onDisconnected).toHaveBeenCalledTimes(1);
  });
});

describe("keepalive", () => {
  it("sends keepalives, and a ping every so often", () => {
    const { connection, handshake, latest } = setup();
    connection.start();
    handshake();
    const socket = latest();
    const pingsBefore = socket.ofType("ping").length;

    for (let tick = 0; tick < 6; tick += 1) {
      vi.advanceTimersByTime(20_000);
      socket.receive("keepalive");
    }

    expect(socket.sent.filter((m) => m === "keepalive")).toHaveLength(6);
    // Three follow-ups after joining, then one for every three keepalives.
    expect(socket.ofType("ping")).toHaveLength(pingsBefore + 3 + 2);
  });

  it("measures the clock again soon after joining", () => {
    const { connection, handshake, latest } = setup();
    connection.start();
    handshake();
    const socket = latest();
    const pingsBefore = socket.ofType("ping").length;

    vi.advanceTimersByTime(5000);
    expect(socket.ofType("ping")).toHaveLength(pingsBefore + 1);

    vi.advanceTimersByTime(10_000);
    expect(socket.ofType("ping")).toHaveLength(pingsBefore + 2);
  });

  it("drops the follow-up measurements with the connection", () => {
    const { connection, handshake, latest } = setup();
    connection.start();
    handshake();
    const socket = latest();
    const pingsBefore = socket.ofType("ping").length;
    socket.drop();
    vi.advanceTimersByTime(800);

    expect(socket.ofType("ping")).toHaveLength(pingsBefore);
    connection.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconnects when the server stops answering", () => {
    const { connection, handshake, sockets, latest, events } = setup();
    connection.start();
    handshake();
    const socket = latest();

    vi.advanceTimersByTime(20_000);
    vi.advanceTimersByTime(20_000);

    expect(socket.closedByClient).toBe(true);
    expect(events.onDisconnected).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });

  it("isn't fooled by a timer slowed down in a background tab", () => {
    const { connection, handshake, latest, events } = setup();
    connection.start();
    handshake();
    const socket = latest();

    vi.advanceTimersByTime(20_000);
    socket.receive("keepalive");
    // A long gap passes, but the last keepalive was answered.
    vi.setSystemTime(Date.now() + 300_000);
    vi.advanceTimersByTime(20_000);

    expect(socket.closedByClient).toBe(false);
    expect(events.onDisconnected).not.toHaveBeenCalled();
  });
});

describe("reactions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const relaying = { reactions: true };

  it("sends a reaction once the room says it relays them", () => {
    const { connection, latest, handshake } = setup();
    connection.start();
    handshake(latest(), relaying);

    expect(connection.sendReaction("clap")).toBe(true);
    expect(latest().ofType("react")).toEqual([{ type: "react", emoji: "clap" }]);
  });

  it("sends no reaction to a room that doesn't relay them", () => {
    const { connection, latest, handshake } = setup();
    connection.start();
    handshake();

    expect(connection.relaysReactions()).toBe(false);
    expect(connection.sendReaction("clap")).toBe(false);
    expect(latest().ofType("react")).toEqual([]);
  });

  it("stops sending reactions while reconnecting, until the room says so again", () => {
    const { connection, latest, handshake } = setup();
    connection.start();
    handshake(latest(), relaying);
    expect(connection.relaysReactions()).toBe(true);

    latest().drop();
    expect(connection.relaysReactions()).toBe(false);
    expect(connection.sendReaction("clap")).toBe(false);

    // Back on a room that doesn't relay them, as after changing to an older server.
    vi.advanceTimersByTime(2000);
    handshake();
    expect(connection.relaysReactions()).toBe(false);
    expect(connection.sendReaction("clap")).toBe(false);

    latest().drop();
    vi.advanceTimersByTime(4000);
    handshake(latest(), relaying);
    expect(connection.sendReaction("clap")).toBe(true);
  });

  it("passes on a reaction it hears", () => {
    const { connection, latest, handshake, events } = setup();
    connection.start();
    handshake();

    latest().receive({ type: "reaction", emoji: "fire", from: "c2" });

    expect(events.onReaction).toHaveBeenCalledWith("fire", "c2");
  });
});
