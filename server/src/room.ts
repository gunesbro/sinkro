import { DurableObject } from "cloudflare:workers";
import {
  CloseCode,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ErrorCode,
  type RoomState,
  type ServerMessage,
} from "./protocol";

/** People in a room. */
const MAX_CONNECTIONS = 50;
/** Sockets of any kind, so ones that never join can't crowd people out. */
const MAX_SOCKETS = 100;
/** Each save is a row write against the daily limit, and states can come several a second. */
const SAVE_EVERY_MS = 1000;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
/** Longer than any film, so this only closes rooms that were forgotten with a tab left open. */
const IDLE_LIMIT_MS = 12 * 60 * 60 * 1000;
/** Each check wakes the room, so it's rare. A room can stay open this much past the limit. */
const IDLE_CHECK_MS = 60 * 60 * 1000;
const MAX_CLOCK_ERROR_MS = 30_000;
const RATE_LIMIT_MESSAGES = 50;
const RATE_LIMIT_WINDOW_MS = 10_000;
/** Answered by the runtime without waking the room, so idle connections cost nothing. */
const KEEPALIVE = "keepalive";

type RoomRecord = {
  state: RoomState | null;
  seq: number;
  video?: string;
  /** When someone last joined, or played, paused, seeked or moved the room to another video. */
  activeAt?: number;
};
/** Kept with the socket, so who's on an ad goes when they do and is never stored. */
type Attachment = {
  clientId: string | null;
  onAd?: boolean;
  viewer?: string;
  drift?: number;
  /** Asked to come to the room's new video, and hasn't yet. */
  behind?: boolean;
};
/** Smaller changes to the room's spread aren't worth waking everyone for. */
const SPREAD_STEP_SECONDS = 0.05;
type RateWindow = { startedAt: number; count: number };

/**
 * One room. Everything that must survive hibernation lives in storage or in the
 * socket attachment. Only the rate limit windows are in memory: an idle room has
 * no traffic to limit.
 */
export class Room extends DurableObject {
  private readonly rateWindows = new WeakMap<WebSocket, RateWindow>();
  /** The newest record while it waits to be saved, which then wins over storage. */
  private unsaved: RoomRecord | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSaveAt = 0;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(KEEPALIVE, KEEPALIVE));
  }

  /** Claims this room. Returns false if the code is already taken. */
  async create(): Promise<boolean> {
    if (await this.readRecord()) return false;
    await this.saveRecord({ state: null, seq: 0 });
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    return true;
  }

  override async fetch(): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();

    // Browsers hide the HTTP status of a failed upgrade, so refusals are sent as
    // close codes on an accepted socket. These sockets don't join the hibernation set.
    const refusal = !(await this.readRecord())
      ? CloseCode.RoomNotFound
      : this.joinedSockets().length >= MAX_CONNECTIONS ||
          this.ctx.getWebSockets().length >= MAX_SOCKETS
        ? CloseCode.RoomFull
        : null;
    if (refusal !== null) {
      server.accept();
      server.close(refusal);
    } else {
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ clientId: null } satisfies Attachment);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Every message gets an answer, even when something fails, so no client waits for good. */
  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    try {
      await this.handleMessage(ws, raw);
    } catch {
      this.sendError(ws, "server_error");
    }
  }

  private async handleMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (!this.withinRateLimit(ws)) return this.sendError(ws, "rate_limited");

    const message = parseClientMessage(raw);
    if (!message) return this.sendError(ws, "invalid_message");

    switch (message.type) {
      case "ping":
        // Allowed before joining so clients can measure the clock offset first.
        return this.send(ws, {
          type: "pong",
          clientTime: message.clientTime,
          serverTime: Date.now(),
        });
      case "join":
        if (message.protocol < MIN_PROTOCOL_VERSION || message.protocol > PROTOCOL_VERSION) {
          return ws.close(CloseCode.ProtocolMismatch);
        }
        return this.join(ws, message.viewer);
      case "ad": {
        const clientId = this.clientIdOf(ws);
        if (!clientId) return this.sendError(ws, "not_joined");
        if (this.isOnAd(ws) === message.watching) return;
        this.patchAttachment(ws, { onAd: message.watching });
        this.announceAds();
        return;
      }
      case "behind": {
        if (!this.clientIdOf(ws)) return this.sendError(ws, "not_joined");
        if (this.isBehind(ws) === message.behind) return;
        this.patchAttachment(ws, { behind: message.behind });
        this.announceBehind();
        return;
      }
      case "drift": {
        if (!this.clientIdOf(ws)) return this.sendError(ws, "not_joined");
        this.patchAttachment(ws, { drift: message.seconds });
        this.announceSpread();
        return;
      }
      case "video/get": {
        const record = await this.readRecord();
        if (!record) return ws.close(CloseCode.RoomNotFound);
        return this.send(ws, { type: "video", sealed: record.video ?? null });
      }
      case "video/set": {
        const record = await this.readRecord();
        if (!record) return ws.close(CloseCode.RoomNotFound);
        // Creating a room sets the first one without joining. After that it takes someone in
        // the room, or anyone with the code could send everyone somewhere else.
        if (record.video && !this.clientIdOf(ws)) return this.sendError(ws, "not_joined");
        await this.saveRecord({
          ...record,
          video: message.sealed,
          activeAt: Date.now(),
          // Someone joining the new film mustn't be sent to where the old one had got to.
          state: message.fresh ? null : record.state,
        });
        const video: ServerMessage = { type: "video", sealed: message.sealed };
        this.send(ws, video);
        this.broadcast(message.fresh ? { ...video, fresh: true } : video, ws);
        return;
      }
      case "state": {
        const clientId = this.clientIdOf(ws);
        if (!clientId) return this.sendError(ws, "not_joined");

        const record = await this.readRecord();
        // Unreachable while connected unless the room expired underneath the socket.
        if (!record) return ws.close(CloseCode.RoomNotFound);

        const { type: _, ...playback } = message;
        const now = Date.now();
        const state: RoomState = {
          ...playback,
          // A badly wrong clock mustn't move everyone else's target position.
          sentAt: Math.abs(playback.sentAt - now) > MAX_CLOCK_ERROR_MS ? now : playback.sentAt,
          seq: record.seq + 1,
          from: clientId,
        };
        // Everyone hears it even if saving fails, say on a used-up daily quota: the room keeps
        // going, and only someone joining later misses the latest state.
        await this.saveSoon({ ...record, state, seq: state.seq, activeAt: now }).catch(
          () => undefined,
        );
        this.broadcast({ type: "state", ...state });
        // Everyone heads for the new state, so what they said before it no longer holds.
        for (const socket of this.joinedSockets())
          this.patchAttachment(socket, { drift: undefined });
        this.lastSpread = null;
        return;
      }
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  override async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) {
      await this.forgetRoom();
      return;
    }

    const record = await this.readRecord();
    const now = Date.now();
    if (record && now - (record.activeAt ?? now) < IDLE_LIMIT_MS) {
      await this.ctx.storage.setAlarm(now + IDLE_CHECK_MS);
      return;
    }
    await this.forgetRoom();
    for (const socket of sockets) socket.close(CloseCode.RoomIdle);
  }

  private async join(ws: WebSocket, viewer?: string): Promise<void> {
    if (this.clientIdOf(ws)) return;

    const record = await this.readRecord();
    if (!record) return ws.close(CloseCode.RoomNotFound);

    // After a network drop the old socket can look open for a long time, and it's this viewer.
    let replacedOneOnAd = false;
    let replacedOneBehind = false;
    if (viewer) {
      for (const socket of this.joinedSockets()) {
        if (socket === ws || this.viewerOf(socket) !== viewer) continue;
        replacedOneOnAd ||= this.isOnAd(socket);
        replacedOneBehind ||= this.isBehind(socket);
        socket.serializeAttachment({ clientId: null } satisfies Attachment);
        socket.close(1000);
      }
    }

    const clientId = crypto.randomUUID();
    ws.serializeAttachment({ clientId, ...(viewer ? { viewer } : {}) } satisfies Attachment);
    await this.saveRecord({ ...record, activeAt: Date.now() });
    await this.ctx.storage.setAlarm(Date.now() + IDLE_CHECK_MS);

    const peers = this.joinedSockets().length;
    const video = record.video ? { video: record.video } : {};
    const othersOnAd = this.joinedSockets().filter((socket) => this.isOnAd(socket)).length;
    const ads = othersOnAd > 0 ? { ads: othersOnAd } : {};
    this.send(ws, { type: "joined", clientId, state: record.state, peers, ...video, ...ads });
    this.broadcast({ type: "peers", count: peers }, ws);
    if (replacedOneOnAd) this.announceAds();
    if (replacedOneBehind) this.announceBehind();
    const behind = this.joinedSockets().filter((socket) => this.isBehind(socket)).length;
    if (behind > 0) this.send(ws, { type: "left_behind", count: behind });
    const spread = this.spread();
    if (spread !== null)
      this.send(ws, { type: "spread", seconds: Math.round(spread * 1000) / 1000 });
  }

  /** Runs on both close and error, which can fire for the same socket. */
  private async leave(ws: WebSocket): Promise<void> {
    const remaining = this.joinedSockets().filter((socket) => socket !== ws);
    if (this.clientIdOf(ws)) {
      const wasOnAd = this.isOnAd(ws);
      const wasBehind = this.isBehind(ws);
      ws.serializeAttachment({ clientId: null } satisfies Attachment);
      this.broadcast({ type: "peers", count: remaining.length }, ws);
      if (wasOnAd) this.announceAds();
      if (wasBehind) this.announceBehind();
      this.lastSpread = null;
      this.announceSpread();
    }

    if (remaining.length === 0 && (await this.readRecord())) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    }
  }

  /** Saves at once, replacing anything waiting. */
  private async saveRecord(record: RoomRecord): Promise<void> {
    this.cancelSave();
    this.unsaved = null;
    this.lastSaveAt = Date.now();
    await this.ctx.storage.put<RoomRecord>("room", record);
  }

  /** Keeps the newest in memory and saves it at most once a second. */
  private async saveSoon(record: RoomRecord): Promise<void> {
    const wait = this.lastSaveAt + SAVE_EVERY_MS - Date.now();
    if (wait <= 0) return this.saveRecord(record);
    this.unsaved = record;
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = null;
      const pending = this.unsaved;
      if (pending) void this.saveRecord(pending).catch(() => undefined);
    }, wait);
  }

  private cancelSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  private async forgetRoom(): Promise<void> {
    this.cancelSave();
    this.unsaved = null;
    await this.ctx.storage.deleteAll();
  }

  private readRecord(): Promise<RoomRecord | undefined> {
    if (this.unsaved) return Promise.resolve(this.unsaved);
    return this.ctx.storage.get<RoomRecord>("room");
  }

  /** Keeps whatever else the socket carries, which survives the room hibernating. */
  private patchAttachment(ws: WebSocket, change: Partial<Attachment>): void {
    const current = (ws.deserializeAttachment() as Attachment | null) ?? { clientId: null };
    ws.serializeAttachment({ ...current, ...change } satisfies Attachment);
  }

  private lastSpread: number | null = null;

  /** From what each person says of themselves, so it only counts who has said. */
  private spread(): number | null {
    const drifts = this.joinedSockets()
      .map((socket) => (socket.deserializeAttachment() as Attachment | null)?.drift)
      .filter((drift): drift is number => typeof drift === "number");
    return drifts.length >= 2 ? Math.max(...drifts) - Math.min(...drifts) : null;
  }

  private announceSpread(): void {
    const spread = this.spread();
    if (spread === null) return;
    if (this.lastSpread !== null && Math.abs(spread - this.lastSpread) < SPREAD_STEP_SECONDS) {
      return;
    }
    this.lastSpread = spread;
    this.broadcast({ type: "spread", seconds: Math.round(spread * 1000) / 1000 });
  }

  private viewerOf(ws: WebSocket): string | null {
    return (ws.deserializeAttachment() as Attachment | null)?.viewer ?? null;
  }

  private isOnAd(ws: WebSocket): boolean {
    return (ws.deserializeAttachment() as Attachment | null)?.onAd === true;
  }

  /** Everyone hears about the others, so nobody is told about their own ad. */
  private announceAds(): void {
    const sockets = this.joinedSockets();
    const total = sockets.filter((socket) => this.isOnAd(socket)).length;
    for (const socket of sockets) {
      this.send(socket, { type: "ads", count: total - (this.isOnAd(socket) ? 1 : 0) });
    }
  }

  private isBehind(ws: WebSocket): boolean {
    return (ws.deserializeAttachment() as Attachment | null)?.behind === true;
  }

  /** Like ads: nobody is told about themselves, as they have their own button to follow. */
  private announceBehind(): void {
    const sockets = this.joinedSockets();
    const total = sockets.filter((socket) => this.isBehind(socket)).length;
    for (const socket of sockets) {
      this.send(socket, { type: "left_behind", count: total - (this.isBehind(socket) ? 1 : 0) });
    }
  }

  private clientIdOf(ws: WebSocket): string | null {
    return (ws.deserializeAttachment() as Attachment | null)?.clientId ?? null;
  }

  private joinedSockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((socket) => socket.readyState === WebSocket.OPEN && this.clientIdOf(socket));
  }

  private withinRateLimit(ws: WebSocket): boolean {
    const now = Date.now();
    const current = this.rateWindows.get(ws);
    if (!current || now - current.startedAt >= RATE_LIMIT_WINDOW_MS) {
      this.rateWindows.set(ws, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= RATE_LIMIT_MESSAGES;
  }

  private broadcast(message: ServerMessage, except?: WebSocket): void {
    for (const socket of this.joinedSockets()) {
      if (socket !== except) this.send(socket, message);
    }
  }

  private sendError(ws: WebSocket, code: ErrorCode): void {
    this.send(ws, { type: "error", code });
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // The socket closed mid-broadcast; webSocketClose cleans up.
    }
  }
}
