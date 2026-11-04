import type { PlaybackState } from "../../../../server/src/protocol";

/** Below this, people can't tell two screens apart, so nothing is corrected. */
export const IGNORE_DRIFT_SECONDS = 0.3;
/** A correction runs until drift is this small, or it would stall just under the limit above. */
const SETTLED_DRIFT_SECONDS = 0.1;
/** Above this, catching up by speed would take too long. */
const SEEK_DRIFT_SECONDS = 2;
/** The speed change stays within ±5% so it can't be heard or seen. */
const MAX_RATE_CHANGE = 0.05;
/** Speed change per second of drift: 0.3 s plays at ±3%, 0.5 s and up at ±5%. */
const RATE_CHANGE_PER_SECOND = 0.1;

/** Where the shared timeline is at this moment, in seconds into the video. */
export function targetPosition(state: PlaybackState, serverNow: number, duration: number): number {
  const elapsed = state.playing ? (Math.max(0, serverNow - state.sentAt) / 1000) * state.rate : 0;
  const position = state.position + elapsed;
  return Number.isFinite(duration) ? Math.min(position, duration) : position;
}

export type Correction = { kind: "none" } | { kind: "rate"; rate: number } | { kind: "seek" };

/** `drift` is local position minus target: positive means this viewer is ahead. */
export function planCorrection(input: {
  drift: number;
  playing: boolean;
  correcting: boolean;
  baseRate: number;
}): Correction {
  const size = Math.abs(input.drift);

  // A paused picture can't catch up by speed, and a seek there is invisible anyway.
  if (!input.playing) return size < IGNORE_DRIFT_SECONDS ? { kind: "none" } : { kind: "seek" };

  if (size > SEEK_DRIFT_SECONDS) return { kind: "seek" };
  if (size < (input.correcting ? SETTLED_DRIFT_SECONDS : IGNORE_DRIFT_SECONDS)) {
    return { kind: "none" };
  }

  const change = Math.min(size * RATE_CHANGE_PER_SECOND, MAX_RATE_CHANGE);
  return { kind: "rate", rate: input.baseRate * (input.drift > 0 ? 1 - change : 1 + change) };
}
