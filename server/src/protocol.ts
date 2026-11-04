// Wire protocol between the extension and a room. See server/README.md.
// This file has no runtime dependencies so the extension can import it too.

export const PROTOCOL_VERSION = 1;

/** WebSocket close codes the client can act on. */
export const CloseCode = {
  ProtocolMismatch: 4400,
  RoomNotFound: 4404,
  RoomFull: 4409,
} as const;

export type ErrorCode = "invalid_message" | "not_joined" | "rate_limited";

export type PlaybackState = {
  playing: boolean;
  /** Seconds into the video at the moment `sentAt`. */
  position: number;
  rate: number;
  /** Sender's estimate of server time, in milliseconds since the epoch. */
  sentAt: number;
};

export type ClientMessage =
  | { type: "join"; protocol: number }
  | ({ type: "state" } & PlaybackState)
  | { type: "ping"; clientTime: number };

/** A playback state as accepted by the room. `seq` orders states; higher wins. */
export type RoomState = PlaybackState & { seq: number; from: string };

export type ServerMessage =
  | { type: "joined"; clientId: string; state: RoomState | null; peers: number }
  | ({ type: "state" } & RoomState)
  | { type: "peers"; count: number }
  | { type: "pong"; clientTime: number; serverTime: number }
  | { type: "error"; code: ErrorCode };

const MAX_MESSAGE_LENGTH = 512;
const MAX_POSITION_SECONDS = 7 * 24 * 60 * 60;
// The range browsers accept for HTMLMediaElement.playbackRate.
const MIN_RATE = 0.0625;
const MAX_RATE = 16;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Returns null for anything that isn't a well-formed client message. */
export function parseClientMessage(raw: string | ArrayBuffer): ClientMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE_LENGTH) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;

  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "join":
      return isFiniteNumber(message.protocol) ? { type: "join", protocol: message.protocol } : null;
    case "ping":
      return isFiniteNumber(message.clientTime)
        ? { type: "ping", clientTime: message.clientTime }
        : null;
    case "state": {
      const { playing, position, rate, sentAt } = message;
      if (typeof playing !== "boolean") return null;
      if (!isFiniteNumber(position) || position < 0 || position > MAX_POSITION_SECONDS) return null;
      if (!isFiniteNumber(rate) || rate < MIN_RATE || rate > MAX_RATE) return null;
      if (!isFiniteNumber(sentAt)) return null;
      return { type: "state", playing, position, rate, sentAt };
    }
    default:
      return null;
  }
}
