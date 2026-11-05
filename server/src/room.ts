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

const MAX_CONNECTIONS = 50;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_ERROR_MS = 30_000;
const RATE_LIMIT_MESSAGES = 50;
const RATE_LIMIT_WINDOW_MS = 10_000;
/** Answered by the runtime without waking the room, so idle connections cost nothing. */
const KEEPALIVE = "keepalive";

type RoomRecord = { state: RoomState | null; seq: number };
type Attachment = { clientId: string | null };
type RateWindow = { startedAt: number; count: number };

/**
 * One room. Everything that must survive hibernation lives in storage or in the
 * socket attachment. Only the rate limit windows are in memory: an idle room has
 * no traffic to limit.
 */
export class Room extends DurableObject {
  private readonly rateWindows = new WeakMap<WebSocket, RateWindow>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(KEEPALIVE, KEEPALIVE));
  }

  /** Claims this room. Returns false if the code is already taken. */
  async create(): Promise<boolean> {
    if (await this.readRecord()) return false;
    await this.ctx.storage.put<RoomRecord>("room", { state: null, seq: 0 });
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    return true;
  }

  override async fetch(): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();

    // Browsers hide the HTTP status of a failed upgrade, so refusals are sent as
    // close codes on an accepted socket. These sockets don't join the hibernation set.
    const refusal = !(await this.readRecord())
      ? CloseCode.RoomNotFound
      : this.ctx.getWebSockets().length >= MAX_CONNECTIONS
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

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
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
        return this.join(ws);
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
        await this.ctx.storage.put<RoomRecord>("room", { state, seq: state.seq });
        this.broadcast({ type: "state", ...state });
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
    if (this.ctx.getWebSockets().length > 0) return;
    await this.ctx.storage.deleteAll();
  }

  private async join(ws: WebSocket): Promise<void> {
    if (this.clientIdOf(ws)) return;

    const record = await this.readRecord();
    if (!record) return ws.close(CloseCode.RoomNotFound);

    const clientId = crypto.randomUUID();
    ws.serializeAttachment({ clientId } satisfies Attachment);
    await this.ctx.storage.deleteAlarm();

    const peers = this.joinedSockets().length;
    this.send(ws, { type: "joined", clientId, state: record.state, peers });
    this.broadcast({ type: "peers", count: peers }, ws);
  }

  /** Runs on both close and error, which can fire for the same socket. */
  private async leave(ws: WebSocket): Promise<void> {
    const remaining = this.joinedSockets().filter((socket) => socket !== ws);
    if (this.clientIdOf(ws)) {
      ws.serializeAttachment({ clientId: null } satisfies Attachment);
      this.broadcast({ type: "peers", count: remaining.length }, ws);
    }

    if (remaining.length === 0 && (await this.readRecord())) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    }
  }

  private readRecord(): Promise<RoomRecord | undefined> {
    return this.ctx.storage.get<RoomRecord>("room");
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
