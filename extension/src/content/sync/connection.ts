import {
  CloseCode,
  PROTOCOL_VERSION,
  parseServerMessage,
  type ClientMessage,
  type Film,
  type OutgoingState,
  type Person,
  type PlaybackState,
  type ReactionId,
  type RoomState,
} from "../../../../server/src/protocol";
import type { ServerClock } from "./clock";
import type { OthersFilm } from "./film-match";

/** Must match the auto-response registered by the room. */
const KEEPALIVE = "keepalive";
/** Answered by the runtime without waking the room, so this costs nothing. */
const KEEPALIVE_INTERVAL_MS = 20_000;
/** Clock drift is slow, and each ping wakes the room. */
const PINGS_EVERY_N_KEEPALIVES = 3;
const INITIAL_PINGS = 3;
/** Join anyway if pongs are slow: a rough clock beats not joining. */
const INITIAL_PINGS_TIMEOUT_MS = 3000;
/** The first pings run while the page is still loading, so measure again once it has settled. */
const FOLLOW_UP_PINGS_MS = [5000, 15_000, 30_000];
const MIN_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "closed";
export type CloseReason = "room_not_found" | "room_full" | "protocol_mismatch" | "room_idle";

export type ConnectionEvents = {
  onJoined: (message: {
    clientId: string;
    state: RoomState | null;
    peers: number;
    video?: string;
    ads?: number;
    reactions?: true;
  }) => void;
  onState: (state: RoomState) => void;
  onPeers: (count: number) => void;
  /** How many others are on an ad. */
  onAds: (count: number) => void;
  /** How far apart the furthest two people in the room are. */
  onSpread: (seconds: number) => void;
  /** How many others haven't come to the room's video yet. */
  onLeftBehind: (count: number) => void;
  /** The films the others on the room's video have. */
  onFilms: (films: OthersFilm[]) => void;
  /** Everyone in the room, this viewer too. Only from a server that keeps names. */
  onPeople: (people: Person[]) => void;
  /** Someone else's reaction to the film. `from` is their id, as in the list of people. */
  onReaction: (emoji: ReactionId, from: string) => void;
  /** Someone moved the room to another video. `fresh` means it's a different film. */
  onVideo: (sealed: string, fresh: boolean) => void;
  onRejected: () => void;
  onDisconnected: () => void;
  onStatus: (status: ConnectionStatus, reason: CloseReason | null) => void;
};

/** The parts of WebSocket used here, so tests can drive a connection without a network. */
export type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
};

export type ConnectionOptions = {
  url: string;
  clock: ServerClock;
  events: ConnectionEvents;
  now?: () => number;
  createSocket?: (url: string) => SocketLike;
};

const OPEN = 1;

const CLOSE_REASONS: Record<number, CloseReason> = {
  [CloseCode.ProtocolMismatch]: "protocol_mismatch",
  [CloseCode.RoomNotFound]: "room_not_found",
  [CloseCode.RoomFull]: "room_full",
  [CloseCode.RoomIdle]: "room_idle",
};

/**
 * One viewer's link to a room. Lives in the content script because an MV3 service
 * worker goes to sleep. Reconnects until the room says it's no use.
 */
export class RoomConnection {
  private socket: SocketLike | null = null;
  private stopped = true;
  private joined = false;
  /** Whether the room said it passes reactions on. An older one answers them with an error. */
  private relaying = false;
  private attempts = 0;
  private initialPongs = 0;
  private keepalivesSent = 0;
  private lastReceivedAt = 0;
  private lastKeepaliveAt = 0;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private followUpTimers: ReturnType<typeof setTimeout>[] = [];

  /** Random, and only for this connection's life, so reconnecting isn't taken for someone new. */
  private readonly viewer = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  private readonly now: () => number;
  private readonly createSocket: (url: string) => SocketLike;

  constructor(private readonly options: ConnectionOptions) {
    this.now = options.now ?? Date.now;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
  }

  start(): void {
    this.stopped = false;
    this.attempts = 0;
    this.options.events.onStatus("connecting", null);
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.joined = false;
    this.relaying = false;
  }

  /** Skips the backoff wait, for when the browser reports the network is back. */
  retryNow(): void {
    if (this.stopped || this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.open();
  }

  sendState(state: OutgoingState): boolean {
    return this.joined && this.send({ type: "state", ...state });
  }

  sendDrift(seconds: number): boolean {
    return this.joined && this.send({ type: "drift", seconds });
  }

  sendFilm(film: Film): boolean {
    return this.joined && this.send({ type: "film", ...film });
  }

  sendBehind(behind: boolean): boolean {
    return this.joined && this.send({ type: "behind", behind });
  }

  sendAdState(watching: boolean): boolean {
    return this.joined && this.send({ type: "ad", watching });
  }

  sendName(sealed: string): boolean {
    return this.joined && this.send({ type: "name", sealed });
  }

  /** False, with nothing sent, to a room that hasn't said it relays reactions. */
  sendReaction(emoji: ReactionId): boolean {
    return this.relaysReactions() && this.send({ type: "react", emoji });
  }

  relaysReactions(): boolean {
    return this.joined && this.relaying;
  }

  sendVideo(sealed: string, fresh: boolean): boolean {
    return this.send({ type: "video/set", sealed, ...(fresh ? { fresh: true } : {}) });
  }

  private open(): void {
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.options.url);
    } catch {
      // The browser wouldn't even try, as with ws:// from an https page. Thrown from here it
      // would leave whoever started this half set up, and end the reconnecting without a word.
      this.options.events.onStatus("reconnecting", null);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.initialPongs = 0;

    // Events from a socket we've already replaced must not touch the current one.
    socket.addEventListener("open", () => {
      if (socket === this.socket) this.onOpen();
    });
    socket.addEventListener("message", (event) => {
      if (socket === this.socket) this.onMessage(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (socket === this.socket) this.onClose(event.code);
    });
  }

  private onOpen(): void {
    this.lastReceivedAt = this.now();
    this.sendPing();
    this.joinTimer = setTimeout(() => this.join(), INITIAL_PINGS_TIMEOUT_MS);
  }

  private join(): void {
    if (this.joinTimer !== null) clearTimeout(this.joinTimer);
    this.joinTimer = null;
    this.send({ type: "join", protocol: PROTOCOL_VERSION, viewer: this.viewer });
  }

  private onMessage(raw: unknown): void {
    this.lastReceivedAt = this.now();
    if (raw === KEEPALIVE) return;

    const message = parseServerMessage(raw);
    if (!message) return;

    const { events } = this.options;
    switch (message.type) {
      case "pong":
        this.options.clock.addSample(message.clientTime, message.serverTime, this.now());
        if (this.joinTimer !== null) {
          this.initialPongs += 1;
          if (this.initialPongs < INITIAL_PINGS) this.sendPing();
          else this.join();
        }
        return;
      case "joined":
        this.joined = true;
        this.relaying = message.reactions === true;
        this.attempts = 0;
        this.startKeepalive();
        events.onStatus("connected", null);
        events.onJoined(message);
        return;
      case "state":
        events.onState(message);
        return;
      case "peers":
        events.onPeers(message.count);
        return;
      case "ads":
        events.onAds(message.count);
        return;
      case "spread":
        events.onSpread(message.seconds);
        return;
      case "left_behind":
        events.onLeftBehind(message.count);
        return;
      case "films":
        events.onFilms(message.films);
        return;
      case "people":
        events.onPeople(message.people);
        return;
      case "reaction":
        events.onReaction(message.emoji, message.from);
        return;
      case "video":
        if (message.sealed !== null) events.onVideo(message.sealed, message.fresh === true);
        return;
      case "error":
        events.onRejected();
        return;
    }
  }

  private onClose(code: number): void {
    const wasJoined = this.joined;
    this.joined = false;
    this.relaying = false;
    this.socket = null;
    this.clearTimers();
    if (wasJoined) this.options.events.onDisconnected();
    if (this.stopped) return;

    const reason = CLOSE_REASONS[code];
    if (reason) {
      this.stopped = true;
      this.options.events.onStatus("closed", reason);
      return;
    }
    this.options.events.onStatus("reconnecting", null);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const ceiling = Math.min(MAX_RECONNECT_DELAY_MS, MIN_RECONNECT_DELAY_MS * 2 ** this.attempts);
    this.attempts += 1;
    // Jitter, so a whole room doesn't come back in the same instant after a server restart.
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private startKeepalive(): void {
    this.keepalivesSent = 0;
    this.lastKeepaliveAt = this.now();
    this.keepaliveTimer = setInterval(() => this.onKeepaliveTick(), KEEPALIVE_INTERVAL_MS);
    this.followUpTimers = FOLLOW_UP_PINGS_MS.map((delay) =>
      setTimeout(() => this.sendPing(), delay),
    );
  }

  private onKeepaliveTick(): void {
    // Compared to the last keepalive rather than a fixed age: background tabs can have
    // their timers slowed to once a minute, which must not read as a dead connection.
    if (this.lastReceivedAt < this.lastKeepaliveAt) {
      const socket = this.socket;
      this.onClose(0);
      socket?.close();
      return;
    }
    this.lastKeepaliveAt = this.now();
    this.socket?.send(KEEPALIVE);
    this.keepalivesSent += 1;
    if (this.keepalivesSent % PINGS_EVERY_N_KEEPALIVES === 0) this.sendPing();
  }

  private sendPing(): void {
    this.send({ type: "ping", clientTime: this.now() });
  }

  private send(message: ClientMessage): boolean {
    if (this.socket?.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private clearTimers(): void {
    if (this.joinTimer !== null) clearTimeout(this.joinTimer);
    if (this.keepaliveTimer !== null) clearInterval(this.keepaliveTimer);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.followUpTimers.forEach(clearTimeout);
    this.followUpTimers = [];
    this.joinTimer = null;
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
  }
}
