// Wire protocol between the extension and a room. See server/README.md.
// This file has no runtime dependencies so the extension can import it too.

export const PROTOCOL_VERSION = 1;
/** The oldest version the server still works with. Raising it locks out existing installs. */
export const MIN_PROTOCOL_VERSION = 1;

/** WebSocket close codes the client can act on. */
export const CloseCode = {
  ProtocolMismatch: 4400,
  RoomNotFound: 4404,
  RoomFull: 4409,
  /** Nothing happened in the room for too long. Clients that don't know it reconnect and get RoomNotFound. */
  RoomIdle: 4408,
} as const;

export type ErrorCode = "invalid_message" | "not_joined" | "rate_limited";

export type PlaybackState = {
  playing: boolean;
  /** Seconds into the video at the moment `sentAt`. */
  position: number;
  rate: number;
  /** Sender's estimate of server time, in milliseconds since the epoch. */
  sentAt: number;
  /** The film's length in seconds, so others can tell they're on a different source. */
  duration?: number;
  /** The site its player comes from, sealed with the room code. Opaque to the server. */
  source?: string;
};

export type ClientMessage =
  /**
   * `viewer` is a random value from one page's connection, kept through its reconnects, so a
   * socket whose network dropped isn't counted alongside the one replacing it.
   */
  | { type: "join"; protocol: number; viewer?: string }
  | ({ type: "state" } & PlaybackState)
  | { type: "ping"; clientTime: number }
  /** The room's video, sealed. Both work without joining. Setting it tells everyone who joined. */
  | { type: "video/get" }
  /** `fresh` means it's a different film, so the room's position no longer means anything. */
  | { type: "video/set"; sealed: string; fresh?: boolean }
  /** Whether this viewer is sitting through an ad, so the others can choose to wait. */
  | { type: "ad"; watching: boolean };

/** A playback state as accepted by the room. `seq` orders states; higher wins. */
export type RoomState = PlaybackState & { seq: number; from: string };

export type ServerMessage =
  | {
      type: "joined";
      clientId: string;
      state: RoomState | null;
      peers: number;
      video?: string;
      /** How many others are on an ad, when any are. */
      ads?: number;
    }
  /** How many people other than the one receiving this are on an ad. */
  | { type: "ads"; count: number }
  | ({ type: "state" } & RoomState)
  | { type: "peers"; count: number }
  | { type: "pong"; clientTime: number; serverTime: number }
  | { type: "video"; sealed: string | null; fresh?: boolean }
  | { type: "error"; code: ErrorCode };

const MAX_MESSAGE_LENGTH = 4096;
const MAX_VIEWER_LENGTH = 64;
/** Room for a sealed 2048-character address and a title, and small enough to store for every room. */
const MAX_SEALED_VIDEO_LENGTH = 3900;
const MAX_POSITION_SECONDS = 7 * 24 * 60 * 60;
/** Room for a sealed host name of up to 253 characters. */
const MAX_SOURCE_LENGTH = 400;
// The range browsers accept for HTMLMediaElement.playbackRate.
export const MIN_RATE = 0.0625;
export const MAX_RATE = 16;
const ERROR_CODES: readonly unknown[] = [
  "invalid_message",
  "not_joined",
  "rate_limited",
] satisfies ErrorCode[];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function parsePlayback(value: Record<string, unknown>): PlaybackState | null {
  const { playing, position, rate, sentAt } = value;
  if (typeof playing !== "boolean") return null;
  if (!isFiniteNumber(position) || position < 0 || position > MAX_POSITION_SECONDS) return null;
  if (!isFiniteNumber(rate) || rate < MIN_RATE || rate > MAX_RATE) return null;
  if (!isFiniteNumber(sentAt)) return null;
  // Optional, so a bad one is dropped rather than costing the whole state.
  const { duration, source } = value;
  return {
    playing,
    position,
    rate,
    sentAt,
    ...(isFiniteNumber(duration) && duration > 0 && duration <= MAX_POSITION_SECONDS
      ? { duration }
      : {}),
    ...(typeof source === "string" && source.length > 0 && source.length <= MAX_SOURCE_LENGTH
      ? { source }
      : {}),
  };
}

function parseRoomState(value: Record<string, unknown>): RoomState | null {
  const playback = parsePlayback(value);
  if (!playback || !isFiniteNumber(value.seq) || typeof value.from !== "string") return null;
  return { ...playback, seq: value.seq, from: value.from };
}

/** Returns null for anything that isn't a well-formed client message. */
export function parseClientMessage(raw: string | ArrayBuffer): ClientMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE_LENGTH) return null;

  const message = parseRecord(raw);
  if (!message) return null;

  switch (message.type) {
    case "join":
      if (!isFiniteNumber(message.protocol)) return null;
      return typeof message.viewer === "string" &&
        message.viewer.length > 0 &&
        message.viewer.length <= MAX_VIEWER_LENGTH
        ? { type: "join", protocol: message.protocol, viewer: message.viewer }
        : { type: "join", protocol: message.protocol };
    case "ping":
      return isFiniteNumber(message.clientTime)
        ? { type: "ping", clientTime: message.clientTime }
        : null;
    case "state": {
      const playback = parsePlayback(message);
      return playback && { type: "state", ...playback };
    }
    case "ad":
      return typeof message.watching === "boolean"
        ? { type: "ad", watching: message.watching }
        : null;
    case "video/get":
      return { type: "video/get" };
    case "video/set":
      return typeof message.sealed === "string" &&
        message.sealed.length > 0 &&
        message.sealed.length <= MAX_SEALED_VIDEO_LENGTH
        ? {
            type: "video/set",
            sealed: message.sealed,
            ...(message.fresh === true ? { fresh: true } : {}),
          }
        : null;
    default:
      return null;
  }
}

/**
 * Returns null for anything that isn't a well-formed server message. The server URL
 * is user-configurable, so a client can't assume it's talking to this code.
 */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== "string") return null;

  const message = parseRecord(raw);
  if (!message) return null;

  switch (message.type) {
    case "joined": {
      const { clientId, peers, state, video, ads } = message;
      if (typeof clientId !== "string" || !isFiniteNumber(peers)) return null;
      const parsed = isRecord(state) ? parseRoomState(state) : null;
      if (state !== null && !parsed) return null;
      const joined = { type: "joined" as const, clientId, state: parsed, peers };
      return {
        ...joined,
        ...(typeof video === "string" ? { video } : {}),
        ...(isFiniteNumber(ads) ? { ads } : {}),
      };
    }
    case "state": {
      const state = parseRoomState(message);
      return state && { type: "state", ...state };
    }
    case "peers":
      return isFiniteNumber(message.count) ? { type: "peers", count: message.count } : null;
    case "ads":
      return isFiniteNumber(message.count) ? { type: "ads", count: message.count } : null;
    case "video":
      return typeof message.sealed === "string" || message.sealed === null
        ? {
            type: "video",
            sealed: message.sealed,
            ...(message.fresh === true ? { fresh: true } : {}),
          }
        : null;
    case "pong":
      return isFiniteNumber(message.clientTime) && isFiniteNumber(message.serverTime)
        ? { type: "pong", clientTime: message.clientTime, serverTime: message.serverTime }
        : null;
    case "error":
      return ERROR_CODES.includes(message.code)
        ? { type: "error", code: message.code as ErrorCode }
        : null;
    default:
      return null;
  }
}
