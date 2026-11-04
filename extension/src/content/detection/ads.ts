/** Why this viewer's video can't follow the room right now. */
export type HoldReason = "ad" | "past_end";

/** Common video players mark themselves like this during an ad. No site-specific code. */
const AD_MARKERS = ".ad-showing, .ad-interrupting, .vjs-ad-playing, .vjs-ad-loading, .jw-flag-ads";
/** Ads are rarely longer than this. */
const MAX_AD_SECONDS = 180;
/** The main video has to be at least this many times longer before a short one looks like an ad. */
const MIN_LENGTH_RATIO = 5;
/** Room for a clock's error and for videos ending a moment apart. */
const PAST_END_TOLERANCE_SECONDS = 5;

export type HoldSignals = {
  /** Seconds, NaN before metadata arrives and Infinity for live streams. */
  duration: number;
  /** The longest video this viewer has been synced to on this page, or 0. */
  longestSeen: number;
  /** Where the room is, or null if it has no timeline yet. */
  roomPosition: number | null;
  hasAdMarker: boolean;
  /** The viewer chose this video, so its length says nothing about it being an ad. */
  picked: boolean;
};

export function holdReason(signals: HoldSignals): HoldReason | null {
  if (signals.hasAdMarker) return "ad";
  if (signals.picked || !Number.isFinite(signals.duration)) return null;

  const isShort = signals.duration <= MAX_AD_SECONDS;
  if (isShort && signals.longestSeen >= signals.duration * MIN_LENGTH_RATIO) return "ad";

  if (
    signals.roomPosition !== null &&
    signals.roomPosition > signals.duration + PAST_END_TOLERANCE_SECONDS
  ) {
    return isShort ? "ad" : "past_end";
  }
  return null;
}

/** Looks up through shadow roots too, because players often keep their video in one. */
export function hasAdMarker(video: Element): boolean {
  let element: Element | null = video;
  while (element) {
    if (element.closest(AD_MARKERS)) return true;
    const root: Node = element.getRootNode();
    element = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}
