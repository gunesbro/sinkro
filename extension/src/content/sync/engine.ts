import {
  MAX_RATE,
  MIN_RATE,
  type PlaybackState,
  type RoomState,
} from "../../../../server/src/protocol";
import { IGNORE_DRIFT_SECONDS, planCorrection, targetPosition } from "./timeline";

/** Rate limit on the server is 5 messages a second; this leaves room for pings. */
const PUBLISH_INTERVAL_MS = 250;
const TICK_INTERVAL_MS = 1000;
/** Playing video fires timeupdate even in a background tab, where timers are throttled. */
const MIN_TICK_GAP_MS = 200;
const PLAY_PAUSE_FLAG_MS = 2000;
const SEEK_FLAG_MS = 15_000;
/** Stops a slow connection from turning into a loop of seek, buffer, fall behind, seek. */
const SEEK_COOLDOWN_MS = 5000;
const AUTOPLAY_RETRY_MS = 5000;
/** A local event landing this close to the timeline is player noise, not somebody's action. */
const SAME_POSITION_SECONDS = 0.5;
/** A seek we applied that lands further off than this was overridden by the viewer. */
const OWN_SEEK_TOLERANCE_SECONDS = 1;
const ENDED_TOLERANCE_SECONDS = 0.5;
const RATE_EPSILON = 0.001;
/** HTMLMediaElement.HAVE_FUTURE_DATA: enough is buffered to keep playing. */
const HAVE_FUTURE_DATA = 3;

export type SyncedVideo = Pick<
  HTMLMediaElement,
  | "addEventListener"
  | "currentTime"
  | "duration"
  | "ended"
  | "pause"
  | "paused"
  | "play"
  | "playbackRate"
  | "readyState"
  | "seeking"
>;

export type EngineDeps = {
  now: () => number;
  serverNow: () => number;
  /** Returns false if the message couldn't be handed to the connection. */
  send: (state: PlaybackState) => boolean;
};

export type EngineSnapshot = {
  hasVideo: boolean;
  /** Seconds this viewer is ahead of the room, or null without a video and a timeline. */
  drift: number | null;
  correcting: boolean;
  /** The browser refused to start playback until the viewer interacts with the page. */
  needsGesture: boolean;
};

/**
 * Keeps one video on the room's shared timeline: applies remote states, publishes what
 * the viewer does, and corrects drift. Everything it knows about the network arrives
 * through the handle* methods, so it can be tested with a fake video and no socket.
 */
export class SyncEngine {
  private video: SyncedVideo | null = null;
  private listeners: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private joined = false;
  private clientId: string | null = null;
  private timeline: PlaybackState | null = null;
  private lastSeq = 0;
  /** States we sent that the room hasn't echoed back yet. */
  private unacked = 0;

  /** The speed people chose, as opposed to what a drift correction is playing at. */
  private baseRate = 1;
  /** The speed we last set, so our own ratechange events can be told apart. */
  private expectedRate = 1;
  private correcting = false;

  // Echo prevention: set when a remote command is applied, consumed by the event it causes.
  private playFlagUntil = 0;
  private pauseFlagUntil = 0;
  private pendingSeek: { position: number; until: number } | null = null;

  private lastSeekAt = Number.NEGATIVE_INFINITY;
  private lastTickAt = Number.NEGATIVE_INFINITY;
  private lastPublishAt = Number.NEGATIVE_INFINITY;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  /** Non-zero while the browser is refusing to autoplay: the time of the next attempt. */
  private autoplayRetryAt = 0;

  constructor(private readonly deps: EngineDeps) {
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  /** Attaches to a video, or to nothing. Safe to call again when the element is swapped. */
  bind(video: SyncedVideo | null): void {
    if (video === this.video) return;

    this.releaseVideo();
    this.video = video;
    if (!video) return;

    this.expectedRate = video.playbackRate;
    if (!this.timeline) this.baseRate = video.playbackRate;

    this.listeners = new AbortController();
    const options = { signal: this.listeners.signal };
    video.addEventListener("play", () => this.onPlay(), options);
    video.addEventListener("pause", () => this.onPause(), options);
    video.addEventListener("seeking", () => this.onSeeking(), options);
    video.addEventListener("seeked", () => this.onSeeked(), options);
    video.addEventListener("ratechange", () => this.onRateChange(), options);
    video.addEventListener("timeupdate", () => this.tick(), options);
    video.addEventListener("canplay", () => this.tick(), options);

    this.syncWithRoom();
  }

  handleJoined(message: { clientId: string; state: RoomState | null; peers: number }): void {
    this.joined = true;
    this.clientId = message.clientId;
    this.unacked = 0;
    this.lastSeq = message.state?.seq ?? 0;
    // A room that was left empty still remembers its last state, but nobody is on that
    // timeline any more. Extrapolating it would jump the video ahead by the time away.
    const isLive = message.state !== null && message.peers > 1;
    this.setTimeline(isLive ? message.state : null);
    this.syncWithRoom();
  }

  handleState(state: RoomState): void {
    if (state.seq <= this.lastSeq) return;
    this.lastSeq = state.seq;

    if (state.from === this.clientId) {
      this.unacked = Math.max(0, this.unacked - 1);
      // The room may have replaced sentAt if this clock is badly wrong, so its copy wins.
      if (this.unacked === 0 && this.publishTimer === null) this.setTimeline(state);
      return;
    }
    // Messages arrive in room order, so a state that overtakes our own echo is older
    // than what we sent, and everyone is about to receive ours after it.
    if (this.unacked > 0 || this.publishTimer !== null) return;

    this.setTimeline(state);
    this.apply(true);
  }

  /** The room dropped a message of ours, so its echo will never come. */
  handleRejected(): void {
    this.unacked = 0;
  }

  /** While offline the viewer is in charge: nothing is corrected, nothing is published. */
  handleDisconnected(): void {
    this.joined = false;
    this.unacked = 0;
    this.cancelPublish();
    this.clearFlags();
    this.finishCorrection();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.handleDisconnected();
    this.bind(null);
  }

  snapshot(): EngineSnapshot {
    const { video, timeline } = this;
    return {
      hasVideo: video !== null,
      drift:
        video && timeline
          ? video.currentTime - targetPosition(timeline, this.deps.serverNow(), video.duration)
          : null,
      correcting: this.correcting,
      needsGesture: this.autoplayRetryAt !== 0,
    };
  }

  private setTimeline(state: PlaybackState | null): void {
    this.timeline = state;
    if (state) this.baseRate = state.rate;
  }

  /** After joining or binding: follow the room if it has a timeline, otherwise start one. */
  private syncWithRoom(): void {
    if (!this.joined || !this.video) return;
    if (this.timeline) this.apply(true);
    else this.publish();
  }

  private tick(): void {
    const now = this.deps.now();
    if (now - this.lastTickAt < MIN_TICK_GAP_MS) return;
    this.lastTickAt = now;
    this.apply(false);
  }

  /** `force` means a new state just arrived, so it can't wait out buffering or a cooldown. */
  private apply(force: boolean): void {
    const { video, timeline } = this;
    if (!this.joined || !video || !timeline) return;

    const target = targetPosition(timeline, this.deps.serverNow(), video.duration);
    const drift = video.currentTime - target;

    if (timeline.playing && video.paused) {
      // Reached the end and the timeline says so too: play() would restart from zero.
      if (video.ended && target >= video.duration - ENDED_TOLERANCE_SECONDS) return;
      if (this.autoplayRetryAt > this.deps.now() && !force) return;
      if (Math.abs(drift) >= IGNORE_DRIFT_SECONDS && (force || !video.seeking)) this.seek(target);
      this.setRate(timeline.rate);
      this.startPlaying();
      return;
    }
    if (!timeline.playing && !video.paused) {
      this.pauseFlagUntil = this.deps.now() + PLAY_PAUSE_FLAG_MS;
      video.pause();
    }

    if (!force && (video.seeking || (timeline.playing && video.readyState < HAVE_FUTURE_DATA))) {
      return;
    }

    const correction = planCorrection({
      drift,
      playing: timeline.playing,
      correcting: this.correcting,
      baseRate: timeline.rate,
    });
    switch (correction.kind) {
      case "none":
        this.correcting = false;
        this.setRate(timeline.rate);
        return;
      case "rate":
        this.correcting = true;
        this.setRate(correction.rate);
        return;
      case "seek":
        if (!force && this.deps.now() - this.lastSeekAt < SEEK_COOLDOWN_MS) return;
        this.correcting = false;
        this.setRate(timeline.rate);
        this.seek(target);
        return;
    }
  }

  private seek(position: number): void {
    const now = this.deps.now();
    this.pendingSeek = { position, until: now + SEEK_FLAG_MS };
    this.lastSeekAt = now;
    if (this.video) this.video.currentTime = position;
  }

  private setRate(rate: number): void {
    const { video } = this;
    if (!video || Math.abs(video.playbackRate - rate) < RATE_EPSILON) return;
    this.expectedRate = rate;
    video.playbackRate = rate;
  }

  private startPlaying(): void {
    const { video } = this;
    if (!video) return;

    this.playFlagUntil = this.deps.now() + PLAY_PAUSE_FLAG_MS;
    void Promise.resolve(video.play()).then(
      () => {
        this.autoplayRetryAt = 0;
      },
      (error: unknown) => {
        this.playFlagUntil = 0;
        // AbortError only means a pause overtook the play, which is normal.
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          this.autoplayRetryAt = this.deps.now() + AUTOPLAY_RETRY_MS;
        }
      },
    );
  }

  private onPlay(): void {
    if (this.consumePlayFlag()) return;
    // The viewer's click is what the browser was waiting for. It means "let me follow",
    // not "everyone go back to where I am".
    if (this.autoplayRetryAt !== 0) {
      this.autoplayRetryAt = 0;
      this.apply(true);
      return;
    }
    this.publishIfChanged();
  }

  private onPause(): void {
    if (this.deps.now() < this.pauseFlagUntil) {
      this.pauseFlagUntil = 0;
      return;
    }
    this.publishIfChanged();
  }

  private onSeeking(): void {
    if (this.hasPendingSeek()) return;
    this.publishIfChanged();
  }

  private onSeeked(): void {
    if (this.hasPendingSeek() && this.pendingSeek && this.video) {
      const landedOff = Math.abs(this.video.currentTime - this.pendingSeek.position);
      this.pendingSeek = null;
      if (landedOff <= OWN_SEEK_TOLERANCE_SECONDS) {
        this.tick();
        return;
      }
    }
    this.publishIfChanged();
  }

  private onRateChange(): void {
    const { video } = this;
    if (!video || Math.abs(video.playbackRate - this.expectedRate) < RATE_EPSILON) return;
    this.expectedRate = video.playbackRate;
    this.baseRate = video.playbackRate;
    this.correcting = false;
    this.publishIfChanged();
  }

  private consumePlayFlag(): boolean {
    const flagged = this.deps.now() < this.playFlagUntil;
    this.playFlagUntil = 0;
    return flagged;
  }

  private hasPendingSeek(): boolean {
    return this.pendingSeek !== null && this.deps.now() < this.pendingSeek.until;
  }

  /** Second line of defence after the flags: only real differences reach the room. */
  private publishIfChanged(): void {
    const { video, timeline } = this;
    if (!this.joined || !video) return;

    if (timeline) {
      const target = targetPosition(timeline, this.deps.serverNow(), video.duration);
      const isSame =
        timeline.playing === !video.paused &&
        Math.abs(timeline.rate - this.baseRate) < RATE_EPSILON &&
        Math.abs(video.currentTime - target) < SAME_POSITION_SECONDS;
      if (isSame) return;
    }

    const wait = this.lastPublishAt + PUBLISH_INTERVAL_MS - this.deps.now();
    if (wait <= 0) {
      this.publish();
    } else if (this.publishTimer === null) {
      // Trailing edge: dragging the seek bar sends where it ended up, not every stop.
      this.publishTimer = setTimeout(() => this.publish(), wait);
    }
  }

  private publish(): void {
    this.cancelPublish();
    const { video } = this;
    if (!this.joined || !video) return;

    const state: PlaybackState = {
      playing: !video.paused,
      position: Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0,
      rate: Math.min(MAX_RATE, Math.max(MIN_RATE, this.baseRate)),
      sentAt: this.deps.serverNow(),
    };
    if (!this.deps.send(state)) return;

    this.unacked += 1;
    this.lastPublishAt = this.deps.now();
    this.timeline = state;
    this.finishCorrection();
  }

  private cancelPublish(): void {
    if (this.publishTimer !== null) clearTimeout(this.publishTimer);
    this.publishTimer = null;
  }

  private clearFlags(): void {
    this.playFlagUntil = 0;
    this.pauseFlagUntil = 0;
    this.pendingSeek = null;
    this.autoplayRetryAt = 0;
  }

  private finishCorrection(): void {
    this.correcting = false;
    this.setRate(this.baseRate);
  }

  private releaseVideo(): void {
    this.finishCorrection();
    this.clearFlags();
    this.listeners?.abort();
    this.listeners = null;
  }
}
