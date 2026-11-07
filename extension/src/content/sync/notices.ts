import type { PlaybackChange } from "./engine";

/** Long enough for a player to finish what looks like several things but is one. */
const SETTLE_MS = 700;

/** `by` is the id of whoever made a change in the room, when it's known to be one person. */
export type ChangeDetails = { rate: number; jumped: boolean; by?: string | null };

/**
 * What several changes in a row come to. Players pause and restart around a seek, so a click
 * on a seek bar arrives as a pause, a jump and a play, which the viewer knows as one thing.
 */
export function summarize(changes: PlaybackChange[], jumped: boolean): PlaybackChange | null {
  const playback = changes.filter((change) => change === "played" || change === "paused");
  const first = playback[0];
  const last = playback.at(-1);
  const isSeek = jumped || changes.includes("seeked");

  // Stopped and started again, or the other way around, leaves things as they were.
  if (first !== last) return isSeek ? "seeked" : null;
  if (last === "played" && isSeek) return "seeked";
  if (last) return last;
  if (isSeek) return "seeked";
  return changes.includes("rate") ? "rate" : null;
}

/** Holds changes until they've settled, then announces what they came to. */
export class ChangeNotices {
  private changes: PlaybackChange[] = [];
  private jumped = false;
  private rate = 1;
  /** Undefined until a change arrives; null once two people's changes are in the same batch. */
  private by: string | null | undefined = undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly announce: (change: PlaybackChange, rate: number, by: string | null) => void,
  ) {}

  add(change: PlaybackChange, { rate, jumped, by = null }: ChangeDetails): void {
    this.changes.push(change);
    this.jumped ||= jumped;
    this.rate = rate;
    this.by = this.by === undefined || this.by === by ? by : null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SETTLE_MS);
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.changes = [];
    this.jumped = false;
    this.by = undefined;
  }

  private flush(): void {
    const summary = summarize(this.changes, this.jumped);
    const { rate } = this;
    const by = this.by ?? null;
    this.stop();
    if (summary) this.announce(summary, rate, by);
  }
}
