import { hasAdEvidence, holdReason, type HoldReason } from "./ads";
import { VideoDiscovery } from "./discovery";
import { pickBest, scoreVideo, type Candidate } from "./score";

const EVALUATE_INTERVAL_MS = 1000;
const MIN_EVALUATE_GAP_MS = 100;
/** Frames report at least this often, so the background can tell a frame has gone. */
const REPORT_HEARTBEAT_MS = 5000;
/** Smaller score changes aren't worth waking the background for. */
const REPORT_SCORE_CHANGE = 5;
const HOVER_SAMPLE_MS = 500;
/**
 * More than one step, or the ratio goes stale. A video sitting exactly on its container's
 * edge counts as intersecting at ratio 0, and moving fully into view from there crosses
 * no threshold at 0 alone, so it would read as invisible for good. YouTube's starts so.
 */
const VISIBILITY_THRESHOLDS = [0, 0.01, 0.1, 0.25, 0.5, 0.75, 1];
/** Looking for ad evidence reads the player's controls, and this gets asked several times a second. */
const AD_CHECK_MS = 1000;

/** What makes a video "the same video": a new one means a different film in the element. */
function fingerprintOf(video: HTMLVideoElement): string {
  return video.currentSrc;
}

export type TrackerEvents = {
  /** The video to sync changed, or it now plays something else. */
  onVideoChange: (video: HTMLVideoElement | null) => void;
  /** This frame's best score, for choosing between frames. */
  onReport: (score: number) => void;
};

/** Scores this frame's videos and keeps track of the best one. */
export class VideoTracker {
  private readonly discovery: VideoDiscovery;
  private readonly visibility: IntersectionObserver;
  private readonly visibleRatios = new WeakMap<HTMLVideoElement, number>();
  private readonly observed = new WeakSet<HTMLVideoElement>();
  private readonly interactions = new WeakMap<HTMLVideoElement, number>();
  private readonly listeners = new AbortController();

  private timer: ReturnType<typeof setInterval> | null = null;
  private current: HTMLVideoElement | null = null;
  private currentFingerprint = "";
  private picked: HTMLVideoElement | null = null;
  /** The longest video synced on this page, which is how a short one gets noticed as an ad. */
  private longestSeen = 0;
  private longestSeenOn = location.href;
  private adEvidence = false;
  private adEvidenceFor: HTMLVideoElement | null = null;
  private adEvidenceAt = Number.NEGATIVE_INFINITY;
  private rememberedSelector: string | null = null;
  private lastEvaluateAt = Number.NEGATIVE_INFINITY;
  private lastHoverAt = Number.NEGATIVE_INFINITY;
  private lastReportedScore = Number.NEGATIVE_INFINITY;
  private lastReportAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly events: TrackerEvents) {
    this.discovery = new VideoDiscovery(() => this.evaluate());
    this.visibility = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          this.visibleRatios.set(entry.target as HTMLVideoElement, entry.intersectionRatio);
        }
      },
      { threshold: VISIBILITY_THRESHOLDS },
    );
  }

  start(rememberedSelector: string | null): void {
    this.rememberedSelector = rememberedSelector;
    const { signal } = this.listeners;
    // Capture on window, and by position rather than target, because player controls
    // usually sit on top of the video and take the events themselves.
    window.addEventListener("pointerdown", (e) => this.noteInteraction(e), {
      capture: true,
      passive: true,
      signal,
    });
    window.addEventListener("pointermove", (e) => this.noteHover(e), {
      capture: true,
      passive: true,
      signal,
    });
    this.discovery.start();
    this.timer = setInterval(() => this.evaluate(), EVALUATE_INTERVAL_MS);
    this.evaluate();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.listeners.abort();
    this.visibility.disconnect();
    this.discovery.stop();
    this.current = null;
  }

  video(): HTMLVideoElement | null {
    return this.current;
  }

  /** Why the current video can't follow the room at `roomPosition`, if it can't. */
  holdReason(roomPosition: number | null, hasOthers: boolean): HoldReason | null {
    const video = this.current;
    if (!video) return null;

    // Navigating within the site starts a new film, whose length says nothing about the last.
    if (location.href !== this.longestSeenOn) {
      this.longestSeenOn = location.href;
      this.longestSeen = 0;
    }
    const reason = holdReason({
      duration: video.duration,
      longestSeen: this.longestSeen,
      roomPosition,
      hasAdEvidence: this.checkAdEvidence(video),
      hasOthers,
      picked: video === this.picked || this.matchesRemembered(video),
    });
    // Ads don't get to set the bar, and neither does a video still being measured against it.
    if (!reason && Number.isFinite(video.duration)) {
      // Alone, whatever this viewer watches is the room's video, however short.
      this.longestSeen = hasOthers ? Math.max(this.longestSeen, video.duration) : video.duration;
    }
    return reason;
  }

  private checkAdEvidence(video: HTMLVideoElement): boolean {
    const now = Date.now();
    if (video !== this.adEvidenceFor || now - this.adEvidenceAt >= AD_CHECK_MS) {
      this.adEvidence = hasAdEvidence(video);
      this.adEvidenceFor = video;
      this.adEvidenceAt = now;
    }
    return this.adEvidence;
  }

  /** The viewer chose this one, or chose a video in another frame (null). */
  setPicked(video: HTMLVideoElement | null): void {
    this.picked = video;
    if (!video) this.rememberedSelector = null;
    this.lastEvaluateAt = Number.NEGATIVE_INFINITY;
    this.evaluate();
  }

  evaluate(): void {
    const now = Date.now();
    if (now - this.lastEvaluateAt < MIN_EVALUATE_GAP_MS) return;
    this.lastEvaluateAt = now;

    const candidates = this.discovery.current().map((video) => this.candidateFor(video, now));
    const best = pickBest(candidates, this.current);
    this.setCurrent(best?.item ?? null);
    this.report(best?.score ?? 0, now);
  }

  private candidateFor(video: HTMLVideoElement, now: number): Candidate<HTMLVideoElement> {
    if (!this.observed.has(video)) {
      this.observed.add(video);
      this.visibility.observe(video);
    }
    const { width, height } = video.getBoundingClientRect();
    const interactedAt = this.interactions.get(video);
    const score = scoreVideo({
      width,
      height,
      screenArea: window.screen.width * window.screen.height,
      // Assume visible until the observer's first callback, which takes a moment.
      visibleRatio: this.visibleRatios.get(video) ?? 1,
      rendered: video.checkVisibility(),
      hasSource: Boolean(video.currentSrc || video.src || video.querySelector("source")),
      playing: !video.paused && !video.ended,
      muted: video.muted || video.volume === 0,
      duration: video.duration,
      loop: video.loop,
      sinceInteraction: interactedAt === undefined ? null : now - interactedAt,
      picked: video === this.picked || this.matchesRemembered(video),
    });
    return { item: video, score };
  }

  private matchesRemembered(video: HTMLVideoElement): boolean {
    if (!this.rememberedSelector) return false;
    try {
      return video.matches(this.rememberedSelector);
    } catch {
      return false;
    }
  }

  private setCurrent(video: HTMLVideoElement | null): void {
    const fingerprint = video ? fingerprintOf(video) : "";
    if (video === this.current && fingerprint === this.currentFingerprint) return;
    this.current = video;
    this.currentFingerprint = fingerprint;
    this.events.onVideoChange(video);
  }

  private report(score: number, now: number): void {
    const changed = Math.abs(score - this.lastReportedScore) >= REPORT_SCORE_CHANGE;
    const isOverdue = now - this.lastReportAt >= REPORT_HEARTBEAT_MS;
    if (!changed && !isOverdue) return;
    this.lastReportedScore = score;
    this.lastReportAt = now;
    this.events.onReport(score);
  }

  private noteInteraction(event: PointerEvent): void {
    const now = Date.now();
    for (const video of this.discovery.current()) {
      const box = video.getBoundingClientRect();
      const isInside =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom;
      if (isInside) this.interactions.set(video, now);
    }
  }

  private noteHover(event: PointerEvent): void {
    const now = Date.now();
    if (now - this.lastHoverAt < HOVER_SAMPLE_MS) return;
    this.lastHoverAt = now;
    this.noteInteraction(event);
  }
}
