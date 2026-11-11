// Whether a video's length means anything to compare. A live stream's "length" is only how far
// back it can be rewound: it grows as the stream goes on, and differs by when each person came.

/** More growth than this, and it's a stream going on rather than a length being settled. */
const GROWTH_SECONDS = 5;
/**
 * A stream grows a few seconds at a time. A jump past this at once is new content in the same
 * player, like a film after the ad before it, not a stream going on.
 */
const NEW_CONTENT_JUMP_SECONDS = 60;
/** Watched this long without growing, a length can be trusted. */
const SETTLED_MS = 6000;

type Seen = { source: string; duration: number; at: number; isLive: boolean };

export type MeasuredVideo = Pick<HTMLVideoElement, "duration" | "currentSrc">;

export class VideoLengths {
  private readonly seen = new WeakMap<MeasuredVideo, Seen>();
  /**
   * The page each video was last seen live on. Going back into a stream's past, a player can
   * swap its endless length for a fixed one, and that's still the stream: it stays live until
   * the page changes, to a recording say.
   */
  private readonly liveOn = new WeakMap<MeasuredVideo, string>();

  constructor(
    private readonly now: () => number = Date.now,
    /** With the query, since some sites show every video at one path, told apart by `?v=`. */
    private readonly page: () => string = () => location.pathname + location.search,
    /** What the player itself says, for players whose video length doesn't show it. */
    private readonly isMarkedLive: (video: MeasuredVideo) => boolean = () => false,
  ) {}

  /** A live stream, by an endless length, by one that keeps growing, or by its player's say. */
  isLive(video: MeasuredVideo): boolean {
    const isLive =
      this.isMarkedLive(video) ||
      (this.look(video)?.isLive ?? video.duration === Number.POSITIVE_INFINITY);
    if (isLive) {
      this.liveOn.set(video, this.page());
      return true;
    }
    return this.liveOn.get(video) === this.page();
  }

  /** A length that's been the same for a while, worth telling others or comparing with theirs. */
  settledLength(video: MeasuredVideo): number | null {
    if (this.isLive(video)) return null;
    const seen = this.look(video);
    if (!seen || this.now() - seen.at < SETTLED_MS) return null;
    return video.duration;
  }

  private look(video: MeasuredVideo): Seen | null {
    const { duration, currentSrc: source } = video;
    if (duration === Number.POSITIVE_INFINITY) {
      const live = { source, duration, at: this.now(), isLive: true };
      this.seen.set(video, live);
      return live;
    }
    if (!Number.isFinite(duration) || duration <= 0) return null;

    const seen = this.seen.get(video);
    // A new film in the same element starts over.
    if (
      !seen ||
      seen.source !== source ||
      duration < seen.duration ||
      duration - seen.duration > NEW_CONTENT_JUMP_SECONDS
    ) {
      const fresh = { source, duration, at: this.now(), isLive: false };
      this.seen.set(video, fresh);
      return fresh;
    }
    if (duration - seen.duration > GROWTH_SECONDS) seen.isLive = true;
    return seen;
  }
}
