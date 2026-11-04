/** What a frame knows about one video at one moment. */
export type VideoSignals = {
  width: number;
  height: number;
  /** Screen area, because frames have viewports of their own and scores get compared across them. */
  screenArea: number;
  /** Share of the element inside the viewport, from 0 to 1. */
  visibleRatio: number;
  /** False for display: none and the like. */
  rendered: boolean;
  playing: boolean;
  muted: boolean;
  /** Seconds. NaN before metadata arrives, Infinity for live streams. */
  duration: number;
  loop: boolean;
  /** Milliseconds since the viewer last clicked or hovered over it, or null if they never have. */
  sinceInteraction: number | null;
  /** The viewer chose it with the picker, just now or on an earlier visit. */
  picked: boolean;
};

/** Below this in either direction, a video is an icon or a thumbnail. */
const MIN_SIDE_PX = 120;
const LONG_VIDEO_SECONDS = 60;
/** Interaction counts for this long, then fades out of the score. */
const INTERACTION_WINDOW_MS = 60_000;
/** A muted video filling less of the screen than this is probably a preview on hover. */
const THUMBNAIL_SHARE = 0.15;

const WEIGHT_AREA = 40;
const BONUS_PLAYING = 25;
const BONUS_UNMUTED = 15;
const BONUS_LONG = 25;
const BONUS_INTERACTION = 20;
const PENALTY_SHORT = 15;
const PENALTY_PREVIEW = 30;
const PENALTY_THUMBNAIL = 20;
/** Beats anything scoring can add up to, so the viewer's choice always wins. */
const BONUS_PICKED = 1000;

/** Zero means "not a candidate". Higher is more likely the video people came to watch. */
export function scoreVideo(video: VideoSignals): number {
  if (video.picked) return BONUS_PICKED;
  if (!video.rendered || video.visibleRatio <= 0) return 0;
  if (video.width < MIN_SIDE_PX || video.height < MIN_SIDE_PX) return 0;

  const share = Math.min(1, (video.width * video.height) / Math.max(1, video.screenArea));
  const isShort = Number.isFinite(video.duration) && video.duration <= LONG_VIDEO_SECONDS;
  const isLong = !Number.isNaN(video.duration) && !isShort;
  const isPreview = video.muted && video.playing && (isShort || video.loop);

  let score = WEIGHT_AREA * share * video.visibleRatio;
  if (video.playing) score += BONUS_PLAYING;
  if (video.playing && !video.muted) score += BONUS_UNMUTED;
  if (isLong) score += BONUS_LONG;
  if (isShort) score -= PENALTY_SHORT;
  if (isPreview) score -= PENALTY_PREVIEW;
  if (video.muted && share < THUMBNAIL_SHARE) score -= PENALTY_THUMBNAIL;

  if (video.sinceInteraction !== null && video.sinceInteraction < INTERACTION_WINDOW_MS) {
    score += BONUS_INTERACTION * (1 - video.sinceInteraction / INTERACTION_WINDOW_MS);
  }

  // A real but unpromising video stays a candidate, so a page with only one still gets it.
  return Math.max(1, score);
}

/** A new favourite has to beat the current one by this much, so sync doesn't flip on noise. */
const SWITCH_MARGIN = 15;

export type Candidate<T> = { item: T; score: number };

/** Keeps `current` unless something clearly beats it or it's no longer a candidate. */
export function pickBest<T>(candidates: Candidate<T>[], current: T | null): Candidate<T> | null {
  let best: Candidate<T> | null = null;
  let held: Candidate<T> | null = null;
  for (const candidate of candidates) {
    if (candidate.score <= 0) continue;
    if (!best || candidate.score > best.score) best = candidate;
    if (candidate.item === current) held = candidate;
  }
  if (best && held && best.score < held.score + SWITCH_MARGIN) return held;
  return best;
}
