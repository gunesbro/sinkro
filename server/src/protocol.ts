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

export type ErrorCode = "invalid_message" | "not_joined" | "rate_limited" | "server_error";

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

/** The reactions a viewer can send. A fixed list, so nothing typed ever travels as one. */
export const REACTION_IDS = ["laugh", "heart", "wow", "sad", "clap", "fire"] as const;
export type ReactionId = (typeof REACTION_IDS)[number];

export function isReactionId(value: unknown): value is ReactionId {
  return (REACTION_IDS as readonly unknown[]).includes(value);
}

/** The parts of a playback state a viewer's action can change. */
export type PlaybackField = "playing" | "position" | "rate";
const PLAYBACK_FIELDS: readonly PlaybackField[] = ["playing", "position", "rate"];

export type ClientMessage =
  /**
   * `viewer` is a random value from one page's connection, kept through its reconnects, so a
   * socket whose network dropped isn't counted alongside the one replacing it.
   */
  | { type: "join"; protocol: number; viewer?: string }
  /**
   * `changed` says what the viewer's action changed, and `basis` is the `seq` of the room's
   * state they last knew, so the room can combine actions that cross. Without them the state
   * replaces the room's whole.
   */
  | ({ type: "state" } & PlaybackState & { changed?: PlaybackField[]; basis?: number })
  | { type: "ping"; clientTime: number }
  /** The room's video, sealed. Both work without joining. Setting it tells everyone who joined. */
  | { type: "video/get" }
  /** `fresh` means it's a different film, so the room's position no longer means anything. */
  | { type: "video/set"; sealed: string; fresh?: boolean }
  /** How far this viewer is from the room's timeline, ahead positive, for the room's spread. */
  | { type: "drift"; seconds: number }
  /** Whether this viewer is sitting through an ad, so the others can choose to wait. */
  | { type: "ad"; watching: boolean }
  /**
   * Whether this viewer isn't on the room's video, so the others can tell who's with them: one
   * that went elsewhere, or hasn't followed after someone brought everyone. Never which page.
   */
  | { type: "behind"; behind: boolean }
  /** This viewer's film, sent when it changes and on joining, so lengths can be compared. */
  | ({ type: "film" } & Film)
  /**
   * The name this viewer goes by in the room, sealed with a key from the room code: the server
   * can't read it. Sent once the room has said it keeps names, with `people`.
   */
  | { type: "name"; sealed: string }
  /**
   * A reaction to the film, for the others to see. Only to a room that said it relays them.
   * Null when parsed from one this version doesn't know.
   */
  | { type: "react"; emoji: ReactionId | null };

/** Someone in the room: the id their states carry as `from`, and their name, sealed. */
export type Person = { id: string; name?: string };

/** What film a viewer has: its length, when known and not live, and its player's site, sealed. */
export type Film = { duration?: number; source?: string };

/** A playback state as accepted by the room. `seq` orders states; higher wins. */
export type RoomState = PlaybackState & { seq: number; from: string };

/** A state as a client sends it: what the viewer's action changed, and the state they knew. */
export type OutgoingState = PlaybackState & { changed?: PlaybackField[]; basis?: number };

export type ServerMessage =
  | {
      type: "joined";
      clientId: string;
      state: RoomState | null;
      peers: number;
      video?: string;
      /** How many others are on an ad, when any are. */
      ads?: number;
      /** The room passes reactions on. A client sends none to a room that doesn't say so. */
      reactions?: true;
    }
  /** How many people other than the one receiving this are on an ad. */
  | { type: "ads"; count: number }
  /** How many people other than the one receiving this aren't on the room's video. */
  | { type: "left_behind"; count: number }
  /** The films the others have, each with how many of them have it. */
  | { type: "films"; films: (Film & { count: number })[] }
  /** How far apart the furthest two people are, from what each says of themselves. */
  | { type: "spread"; seconds: number }
  | ({ type: "state" } & RoomState)
  | { type: "peers"; count: number }
  /** Everyone in the room, the one receiving this included, so names can go with actions. */
  | { type: "people"; people: Person[] }
  /** Someone else's reaction. `from` is their id, as in `people`. */
  | { type: "reaction"; emoji: ReactionId; from: string }
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
/** Room for a short name sealed with its nonce and tag, and well clear of what one needs. */
const MAX_SEALED_NAME_LENGTH = 300;
const MAX_ID_LENGTH = 64;
/** More than a room can hold, so a list never has to be cut short. */
const MAX_PEOPLE = 100;
/** One for each kind of film in a room, which can't be more than its people. */
const MAX_FILMS = 100;
/** Past this, a viewer is seeking, not drifting. */
const MAX_DRIFT_SECONDS = 60;
// The range browsers accept for HTMLMediaElement.playbackRate.
export const MIN_RATE = 0.0625;
export const MAX_RATE = 16;
const ERROR_CODES: readonly unknown[] = [
  "invalid_message",
  "not_joined",
  "rate_limited",
  "server_error",
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

/** Both parts are optional, so a bad one is dropped rather than costing the other. */
function parseFilm(value: Record<string, unknown>): Film {
  const { duration, source } = value;
  return {
    ...(isFiniteNumber(duration) && duration > 0 && duration <= MAX_POSITION_SECONDS
      ? { duration }
      : {}),
    ...(typeof source === "string" && source.length > 0 && source.length <= MAX_SOURCE_LENGTH
      ? { source }
      : {}),
  };
}

/** A bad name is dropped rather than costing the person. */
function parsePerson(value: unknown): Person[] {
  if (!isRecord(value)) return [];
  const { id, name } = value;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) return [];
  return [
    typeof name === "string" && name.length > 0 && name.length <= MAX_SEALED_NAME_LENGTH
      ? { id, name }
      : { id },
  ];
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
      if (!playback) return null;
      // Optional, so a bad one is dropped and the state replaces the room's, as before.
      const changed = Array.isArray(message.changed)
        ? PLAYBACK_FIELDS.filter((field) => (message.changed as unknown[]).includes(field))
        : [];
      const { basis } = message;
      const merging =
        changed.length > 0 && isFiniteNumber(basis) && basis >= 0 ? { changed, basis } : {};
      return { type: "state", ...playback, ...merging };
    }
    case "drift":
      return isFiniteNumber(message.seconds) && Math.abs(message.seconds) <= MAX_DRIFT_SECONDS
        ? { type: "drift", seconds: message.seconds }
        : null;
    case "film":
      return { type: "film", ...parseFilm(message) };
    case "behind":
      return typeof message.behind === "boolean"
        ? { type: "behind", behind: message.behind }
        : null;
    case "ad":
      return typeof message.watching === "boolean"
        ? { type: "ad", watching: message.watching }
        : null;
    case "name":
      return typeof message.sealed === "string" &&
        message.sealed.length > 0 &&
        message.sealed.length <= MAX_SEALED_NAME_LENGTH
        ? { type: "name", sealed: message.sealed }
        : null;
    case "react":
      // One this version doesn't know is null, for the room to drop without an answer: a
      // later extension can send more, and an error would be taken for a refused state.
      return { type: "react", emoji: isReactionId(message.emoji) ? message.emoji : null };
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
      const { clientId, peers, state, video, ads, reactions } = message;
      if (typeof clientId !== "string" || !isFiniteNumber(peers)) return null;
      const parsed = isRecord(state) ? parseRoomState(state) : null;
      if (state !== null && !parsed) return null;
      const joined = { type: "joined" as const, clientId, state: parsed, peers };
      return {
        ...joined,
        ...(typeof video === "string" ? { video } : {}),
        ...(isFiniteNumber(ads) ? { ads } : {}),
        ...(reactions === true ? { reactions } : {}),
      };
    }
    case "state": {
      const state = parseRoomState(message);
      return state && { type: "state", ...state };
    }
    case "peers":
      return isFiniteNumber(message.count) ? { type: "peers", count: message.count } : null;
    case "people":
      return Array.isArray(message.people) && message.people.length <= MAX_PEOPLE
        ? { type: "people", people: message.people.flatMap(parsePerson) }
        : null;
    case "reaction": {
      // One this version doesn't know is dropped, so a later list can grow.
      const { emoji, from } = message;
      return isReactionId(emoji) &&
        typeof from === "string" &&
        from.length > 0 &&
        from.length <= MAX_ID_LENGTH
        ? { type: "reaction", emoji, from }
        : null;
    }
    case "ads":
      return isFiniteNumber(message.count) ? { type: "ads", count: message.count } : null;
    case "left_behind":
      return isFiniteNumber(message.count) ? { type: "left_behind", count: message.count } : null;
    case "films":
      return Array.isArray(message.films) && message.films.length <= MAX_FILMS
        ? {
            type: "films",
            films: message.films.flatMap((entry: unknown) =>
              entry !== null &&
              typeof entry === "object" &&
              isFiniteNumber((entry as { count?: unknown }).count)
                ? [
                    {
                      ...parseFilm(entry as Record<string, unknown>),
                      count: (entry as { count: number }).count,
                    },
                  ]
                : [],
            ),
          }
        : null;
    case "spread":
      return isFiniteNumber(message.seconds) && message.seconds >= 0
        ? { type: "spread", seconds: message.seconds }
        : null;
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
