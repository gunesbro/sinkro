// How the room combines what people do at about the same moment. See server/README.md.
import type { PlaybackField, PlaybackState, RoomState } from "./protocol";

/** When each part of the room's state last changed, and who moved the position. */
export type FieldVersions = {
  playing: number;
  position: number;
  rate: number;
  /** Someone's own earlier seek is known to them even if their message predates its echo. */
  positionBy: string | null;
};

export type Incoming = PlaybackState & {
  /** What the viewer's action changed. Without it, the state replaces the room's whole. */
  changed?: PlaybackField[];
  /** The `seq` of the room's state the sender last knew. */
  basis?: number;
};

/** Seconds into the video at `now`, by a state's own clock. */
function positionAt(state: PlaybackState, now: number): number {
  const elapsed = state.playing ? (Math.max(0, now - state.sentAt) / 1000) * state.rate : 0;
  return Math.max(0, state.position + elapsed);
}

/**
 * Applies only what the viewer's action changed, so two people acting at once both get their
 * way when they changed different things: one pauses and the other seeks, and the room ends up
 * paused where the seek went. Where both changed the same thing, the later one wins.
 *
 * A pause, a play or a change of speed carries a position only because it happened somewhere.
 * If someone moved the room since the sender last heard, that position is from before the move,
 * so the room's own timeline is used instead and the move isn't undone.
 */
export function mergeState(input: {
  current: RoomState | null;
  versions: FieldVersions | undefined;
  incoming: Incoming;
  seq: number;
  from: string;
  now: number;
}): { state: RoomState; versions: FieldVersions } {
  const { current, incoming, seq, from, now } = input;
  const { changed, basis, ...playback } = incoming;
  const replaced = {
    state: { ...playback, seq, from },
    versions: { playing: seq, position: seq, rate: seq, positionBy: from },
  };
  if (!current || !changed || changed.length === 0 || basis === undefined) return replaced;

  const versions = input.versions ?? {
    playing: current.seq,
    position: current.seq,
    rate: current.seq,
    positionBy: current.from,
  };
  const has = (field: PlaybackField) => changed.includes(field);
  const playing = has("playing") ? incoming.playing : current.playing;
  const knowsPosition = versions.position <= basis || versions.positionBy === from;
  // In a paused room, a seek lands where the viewer put it, not where their video got to since.
  const fromIncoming = playing ? positionAt(incoming, now) : incoming.position;
  const position = has("position") || knowsPosition ? fromIncoming : positionAt(current, now);

  return {
    state: {
      playing,
      position,
      rate: has("rate") ? incoming.rate : current.rate,
      sentAt: now,
      ...(incoming.duration !== undefined ? { duration: incoming.duration } : {}),
      ...(incoming.source !== undefined ? { source: incoming.source } : {}),
      seq,
      from,
    },
    versions: {
      playing: has("playing") ? seq : versions.playing,
      position: has("position") ? seq : versions.position,
      rate: has("rate") ? seq : versions.rate,
      positionBy: has("position") ? from : versions.positionBy,
    },
  };
}
