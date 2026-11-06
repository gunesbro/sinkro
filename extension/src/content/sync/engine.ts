import {
  MAX_RATE,
  MIN_RATE,
  type OutgoingState,
  type PlaybackField,
  type PlaybackState,
  type RoomState,
} from "../../../../server/src/protocol";
import type { HoldReason } from "../detection/ads";
import type { ChangeDetails } from "./notices";
import { IGNORE_DRIFT_SECONDS, planCorrection, targetPosition } from "./timeline";

/** Rate limit on the server is 5 messages a second; this leaves room for pings. */
const PUBLISH_INTERVAL_MS = 250;
const TICK_INTERVAL_MS = 1000;
/** Playing video fires timeupdate even in a background tab, where timers are throttled. */
const MIN_TICK_GAP_MS = 200;
const PLAY_PAUSE_FLAG_MS = 2000;
/** Stops a slow connection from turning into a loop of seek, buffer, fall behind, seek. */
const SEEK_COOLDOWN_MS = 5000;
const AUTOPLAY_RETRY_MS = 5000;
/** A local event landing this close to the timeline is player noise, not somebody's action. */
const SAME_POSITION_SECONDS = 0.5;
/** How far from what we asked for a seek can land and still clearly be ours. */
const OWN_SEEK_TOLERANCE_SECONDS = 1;
/** A seek's first event comes right away however slow the network is. Past this it's been lost. */
const OWN_SEEKING_EVENT_MS = 1000;
const ENDED_TOLERANCE_SECONDS = 0.5;
const RATE_EPSILON = 0.001;
/** How long to wait for an element change's event. Some, like a reload's pause, never fire. */
const UNREPORTED_CHANGE_GRACE_MS = 1000;
/** An echo takes a round trip. One this late isn't coming, and waiting for it would deafen. */
const ECHO_TIMEOUT_MS = 3000;
/** A click or key this recent makes the next change the viewer's own. */
const RECENT_INPUT_MS = 1500;
/** Long enough for a player's ad to start over a film it paused itself. */
const UNPROMPTED_PAUSE_WAIT_MS = 500;
/** After a hold, a player puts things back by itself, which isn't anyone's choice. */
const AFTER_HOLD_MS = 4000;
/**
 * Just after joining, or a new video turning up, a page often starts its video by itself, from
 * its own start. That's the player, not the viewer, and it mustn't take the room back with it.
 */
const AFTER_ARRIVING_MS = 4000;
/**
 * How long to wait for word of a click in another frame. Players often take clicks in a frame of
 * their own, and the word comes through the background a moment after the video has moved.
 */
const INPUT_ELSEWHERE_WAIT_MS = 400;
/** HTMLMediaElement.HAVE_METADATA: its length is known. */
const HAVE_METADATA = 1;
/** HTMLMediaElement.HAVE_FUTURE_DATA: enough is buffered to keep playing. */
const HAVE_FUTURE_DATA = 3;

export type SyncedVideo = Pick<
  HTMLMediaElement,
  | "addEventListener"
  | "currentTime"
  | "duration"
  | "ended"
  | "isConnected"
  | "pause"
  | "paused"
  | "play"
  | "playbackRate"
  | "readyState"
  | "seeking"
>;

/** Why a video isn't following the room right now. */
export type Hold = HoldReason | "other_video";

/** What someone just did to the room's video, for telling the viewer. */
export type PlaybackChange = "played" | "paused" | "seeked" | "rate";

/** A jump smaller than this is drift being settled, not someone seeking. */
const SEEK_NOTICE_SECONDS = 2;

export type EngineDeps = {
  now: () => number;
  serverNow: () => number;
  /** Returns false if the message couldn't be handed to the connection. */
  send: (state: OutgoingState) => boolean;
  /** Says why the video can't follow the room right now, such as an ad playing. */
  holdFor?: (roomPosition: number | null) => Hold | null;
  onHoldChange?: (hold: Hold | null) => void;
  /**
   * When the viewer last clicked or pressed a key on the page. Without it, every change counts
   * as the viewer's, which is how it was before.
   */
  lastInputAt?: () => number;
  /** What goes with each state about the film itself, for spotting a different source. */
  filmDetails?: () => Pick<PlaybackState, "duration" | "source">;
  /** `rate` is the speed the room is at now, and `jumped` is whether its position moved too. */
  onRemoteChange?: (change: PlaybackChange, details: ChangeDetails) => void;
  /** This viewer's own action reached the others. Not called when nobody else is there. */
  onOwnChange?: (change: PlaybackChange, details: ChangeDetails) => void;
  /**
   * A live stream: each viewer's position counts from when they opened it, so positions can't
   * be compared, and everyone is at the live edge anyway. Nothing is synced for one.
   */
  isLive?: () => boolean;
};

export type EngineSnapshot = {
  hasVideo: boolean;
  /** True with no video, since nothing is playing then. */
  paused: boolean;
  /** Seconds into the video, or null without one. */
  position: number | null;
  /** Seconds this viewer is ahead of the room, or null without a video and a timeline. */
  drift: number | null;
  correcting: boolean;
  /** The browser refused to start playback until the viewer interacts with the page. */
  needsGesture: boolean;
  /** The video isn't following the room for now, and nothing it does reaches the room. */
  hold: Hold | null;
  /** A live stream, which isn't synced. */
  isLive: boolean;
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
  private hold: Hold | null = null;
  /** Nobody else is in the room, so this viewer's video is the room's timeline. */
  private isAlone = false;
  /** Whether the video was paused the last time we changed it or heard from it. */
  private knownPaused = true;
  private unreportedChangeSince: number | null = null;

  // Echo prevention: set when a remote command is applied, consumed by the event it causes.
  private playFlagUntil = 0;
  private pauseFlagUntil = 0;
  private pendingSeek: {
    position: number;
    seekingExpected: number;
    seekingSeen: number;
    at: number;
  } | null = null;

  private lastSeekAt = Number.NEGATIVE_INFINITY;
  private lastTickAt = Number.NEGATIVE_INFINITY;
  private lastPublishAt = Number.NEGATIVE_INFINITY;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  /** Non-zero while the browser is refusing to autoplay: the time of the next attempt. */
  private autoplayRetryAt = 0;
  private holdEndedAt = Number.NEGATIVE_INFINITY;
  /** When this viewer joined, or this video was bound, whichever was later. */
  private arrivedAt = Number.NEGATIVE_INFINITY;
  private pauseCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** Waiting to hear whether the viewer clicked in another frame, before calling a change theirs. */
  private inputCheckTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.knownPaused = video.paused;
    this.unreportedChangeSince = null;
    if (!this.timeline) this.baseRate = video.playbackRate;

    this.arrivedAt = this.deps.now();
    this.listeners = new AbortController();
    const options = { signal: this.listeners.signal };
    video.addEventListener("play", () => this.onPlay(), options);
    video.addEventListener("pause", () => this.onPause(), options);
    video.addEventListener("seeking", () => this.onSeeking(), options);
    video.addEventListener("seeked", () => this.onSeeked(), options);
    video.addEventListener("ratechange", () => this.onRateChange(), options);
    video.addEventListener("timeupdate", () => this.tick(), options);
    video.addEventListener("canplay", () => this.tick(), options);
    video.addEventListener("emptied", () => this.onEmptied(), options);

    this.syncWithRoom();
  }

  handleJoined(message: { clientId: string; state: RoomState | null; peers: number }): void {
    this.joined = true;
    this.arrivedAt = this.deps.now();
    this.clientId = message.clientId;
    this.unacked = 0;
    this.isAlone = message.peers <= 1;
    this.lastSeq = message.state?.seq ?? 0;
    // A room that was left empty still remembers its last state, but nobody is on that
    // timeline any more. Extrapolating it would jump the video ahead by the time away.
    const isOngoing = message.state !== null && message.peers > 1;
    this.setTimeline(isOngoing ? message.state : null);
    this.syncWithRoom();
  }

  handlePeers(count: number): void {
    const wasAlone = this.isAlone;
    this.isAlone = count <= 1;
    // Whoever just arrived got a timeline this viewer wasn't being held to. Give them the truth.
    if (wasAlone && !this.isAlone && this.joined && this.video && !this.refreshHold()) {
      this.publish();
    }
  }

  handleState(state: RoomState): void {
    if (state.seq <= this.lastSeq) return;
    this.lastSeq = state.seq;

    if (state.from === this.clientId) {
      this.unacked = Math.max(0, this.unacked - 1);
      if (
        this.unacked > 0 ||
        this.publishTimer !== null ||
        this.pauseCheckTimer !== null ||
        this.inputCheckTimer !== null
      )
        return;
      // The room combines what crossed: our pause with someone's seek comes back paused at
      // their seek. So our own state can come back different, and then it's followed too.
      // The room may also have replaced sentAt if this clock is badly wrong: its copy wins.
      const change = this.describeChange(state);
      const jumped = this.hasJumped(state);
      this.setTimeline(state);
      if (change) {
        this.apply(true);
        this.deps.onRemoteChange?.(change, { rate: state.rate, jumped });
      }
      return;
    }
    // A state of ours that was lost has no echo coming, and waiting on it for good would
    // ignore the room until a reconnect, while everything here still looked in sync.
    if (this.unacked > 0 && this.deps.now() - this.lastPublishAt > ECHO_TIMEOUT_MS) {
      this.unacked = 0;
    }
    // Messages arrive in room order, so a state that overtakes our own echo is older
    // than what we sent, and everyone is about to receive ours after it.
    if (
      this.unacked > 0 ||
      this.publishTimer !== null ||
      this.pauseCheckTimer !== null ||
      this.inputCheckTimer !== null
    )
      return;

    const change = this.describeChange(state);
    const jumped = this.hasJumped(state);
    this.setTimeline(state);
    this.apply(true);
    if (change) this.deps.onRemoteChange?.(change, { rate: state.rate, jumped });
  }

  private describeChange(next: PlaybackState): PlaybackChange | null {
    const { timeline } = this;
    if (!timeline) return null;
    if (timeline.playing !== next.playing) return next.playing ? "played" : "paused";
    if (Math.abs(timeline.rate - next.rate) >= RATE_EPSILON) return "rate";

    return this.hasJumped(next) ? "seeked" : null;
  }

  /** What a viewer's action changed, so the room keeps what others changed meanwhile. */
  private changedFields(next: PlaybackState): PlaybackField[] {
    const { timeline } = this;
    if (!timeline) return [];
    const fields: PlaybackField[] = [];
    if (timeline.playing !== next.playing) fields.push("playing");
    if (this.hasJumped(next)) fields.push("position");
    if (Math.abs(timeline.rate - next.rate) >= RATE_EPSILON) fields.push("rate");
    return fields;
  }

  private hasJumped(next: PlaybackState): boolean {
    const { timeline } = this;
    if (!timeline) return false;
    const expected = targetPosition(timeline, next.sentAt, Number.POSITIVE_INFINITY);
    return Math.abs(expected - next.position) > SEEK_NOTICE_SECONDS;
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

  /** The viewer clicked to get past an autoplay block, and a click is what the browser wants. */
  retryPlay(): void {
    // If the browser still says no, the refusal puts the notice back.
    this.autoplayRetryAt = 0;
    this.syncWithRoom();
  }

  /** Something outside the engine changed whether this video should follow the room. */
  recheck(): void {
    this.syncWithRoom();
  }

  /**
   * The room moved to a different film, so its position means nothing any more. Following it
   * would send the new film to wherever the old one had got to. Whoever is watching first
   * starts the new timeline.
   */
  forgetTimeline(): void {
    this.cancelPublish();
    this.unacked = 0;
    this.finishCorrection();
    this.timeline = null;
  }

  /**
   * Makes this viewer's position the room's, for "Bring everyone to me". On an ad it has none
   * to give, so the timeline starts when the ad ends. `isNewFilm` is for arriving from another.
   */
  bringEveryone(isNewFilm = false): void {
    if (isNewFilm) this.forgetTimeline();
    if (!this.refreshHold()) this.publish();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.handleDisconnected();
    this.bind(null);
  }

  snapshot(): EngineSnapshot {
    const { video, timeline } = this;
    const isLive = this.isLive();
    return {
      hasVideo: video !== null,
      paused: video?.paused ?? true,
      position: video?.currentTime ?? null,
      drift:
        video && timeline && !this.hold && !this.isAlone && !isLive
          ? video.currentTime - targetPosition(timeline, this.deps.serverNow(), video.duration)
          : null,
      correcting: this.correcting,
      // A play the browser accepted can take a while to finish while the video loads.
      needsGesture: this.autoplayRetryAt !== 0 && (video?.paused ?? false),
      hold: this.hold,
      isLive,
    };
  }

  private setTimeline(state: PlaybackState | null): void {
    this.timeline = state;
    if (state) this.baseRate = state.rate;
  }

  /** After joining or binding: follow the room if it has a timeline, otherwise start one. */
  private isLive(): boolean {
    return this.video !== null && (this.deps.isLive?.() ?? false);
  }

  private syncWithRoom(): void {
    if (!this.joined || !this.video || this.isLive()) return;
    if (this.timeline) {
      this.apply(true);
      return;
    }
    if (this.video.readyState < HAVE_METADATA || this.refreshHold()) return;

    // Others are here with nothing going yet, like someone sitting through an ad. A paused
    // video here usually means the browser blocked the site's autoplay, not that anyone chose
    // to stop, so it mustn't pause the room. Trying is also what gets the viewer asked to click.
    if (!this.isAlone && this.video.paused) {
      if (this.autoplayRetryAt <= this.deps.now()) this.startPlaying();
      return;
    }
    this.publish();
  }

  /** Returns whether the video is on hold. Asks each time, since an ad can end at any moment. */
  private refreshHold(): boolean {
    const roomPosition = this.timeline
      ? targetPosition(this.timeline, this.deps.serverNow(), Number.POSITIVE_INFINITY)
      : null;
    const hold = this.deps.holdFor?.(roomPosition) ?? null;
    if (hold !== this.hold) {
      if (this.hold && !hold) this.holdEndedAt = this.deps.now();
      this.hold = hold;
      this.deps.onHoldChange?.(hold);
    }
    return hold !== null;
  }

  private tick(): void {
    const now = this.deps.now();
    if (now - this.lastTickAt < MIN_TICK_GAP_MS) return;
    this.lastTickAt = now;
    // A room with no timeline yet may have been waiting for an ad to end.
    if (this.timeline) this.apply(false);
    else this.syncWithRoom();
  }

  /** `force` means a new state just arrived, so it can't wait out buffering or a cooldown. */
  private apply(newState: boolean): void {
    const { video, timeline } = this;
    if (!this.joined || !video || !timeline) return;
    // Leaves a live stream alone, after undoing any speed change made before it was known.
    if (this.isLive()) {
      if (this.correcting) {
        this.correcting = false;
        this.setRate(1);
      }
      return;
    }
    // Playing a video that's been taken out of the page would leave its sound running.
    if (!video.isConnected) return;

    const wasOnHold = this.hold !== null;
    if (this.refreshHold()) {
      this.finishCorrection();
      this.clearFlags();
      this.knownPaused = video.paused;
      this.expectedRate = video.playbackRate;
      return;
    }
    if (this.isAlone) {
      this.finishCorrection();
      return;
    }
    // Coming back from an ad can't wait for a cooldown any more than a new state can.
    const force = newState || wasOnHold;
    // What the viewer just did is on its way, so the timeline here is already out of date.
    // A seek bar's pause goes out first, and following it would undo the seek behind it.
    if (!force && (this.publishTimer !== null || this.pauseCheckTimer !== null)) return;
    // Undoing it while finding out whether the viewer did it would leave nothing to pass on.
    if (this.inputCheckTimer !== null) return;
    if (!force && this.hasUnreportedChange(video)) return;

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
      this.knownPaused = true;
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

  /**
   * Browsers change the element at once and queue the event, with timeupdate ahead of
   * pause. Acting on the gap would undo what the viewer just did before it's reported.
   */
  private hasUnreportedChange(video: SyncedVideo): boolean {
    const changed =
      video.paused !== this.knownPaused ||
      Math.abs(video.playbackRate - this.expectedRate) >= RATE_EPSILON;
    if (!changed) {
      this.unreportedChangeSince = null;
      return false;
    }

    const now = this.deps.now();
    this.unreportedChangeSince ??= now;
    if (now - this.unreportedChangeSince < UNREPORTED_CHANGE_GRACE_MS) return true;

    this.knownPaused = video.paused;
    this.expectedRate = video.playbackRate;
    this.unreportedChangeSince = null;
    return false;
  }

  private seek(position: number): void {
    // A seek replacing one in flight still has that one's seeking event on its way.
    this.pendingSeek = {
      position,
      seekingExpected: (this.pendingSeek?.seekingExpected ?? 0) + 1,
      seekingSeen: this.pendingSeek?.seekingSeen ?? 0,
      at: this.deps.now(),
    };
    this.lastSeekAt = this.deps.now();
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
    const playing = video.play();
    // Stays true if the browser refused, because then no event will come.
    this.knownPaused = video.paused;
    void Promise.resolve(playing).then(
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
    if (this.video) this.knownPaused = this.video.paused;
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
    if (this.video) this.knownPaused = this.video.paused;
    if (this.deps.now() < this.pauseFlagUntil) {
      this.pauseFlagUntil = 0;
      return;
    }
    // Nobody pressed anything: a player pausing for its ad looks like this, and the ad starts
    // a moment later. Waiting that moment lets the ad show, so the room isn't paused for it.
    if (!this.isViewerActing()) {
      if (this.pauseCheckTimer !== null) clearTimeout(this.pauseCheckTimer);
      this.pauseCheckTimer = setTimeout(() => {
        this.pauseCheckTimer = null;
        this.publishIfChanged();
      }, UNPROMPTED_PAUSE_WAIT_MS);
      return;
    }
    this.publishIfChanged();
  }

  private isViewerActing(): boolean {
    const at = this.deps.lastInputAt?.();
    return at === undefined || this.deps.now() - at < RECENT_INPUT_MS;
  }

  private onSeeking(): void {
    const { pendingSeek } = this;
    // Players can drop a seek while reloading. Waiting on its report for good would take the
    // viewer's next seek for it, and pull them back to the room.
    if (
      pendingSeek &&
      pendingSeek.seekingSeen < pendingSeek.seekingExpected &&
      this.deps.now() - pendingSeek.at > OWN_SEEKING_EVENT_MS
    ) {
      this.pendingSeek = null;
    }
    if (this.pendingSeek) {
      this.pendingSeek.seekingSeen += 1;
      return;
    }
    this.publishIfChanged();
  }

  private onSeeked(): void {
    const { pendingSeek, video } = this;
    if (!pendingSeek || !video) {
      this.publishIfChanged();
      return;
    }
    this.pendingSeek = null;

    // Landing elsewhere isn't enough to blame the viewer: a live stream, say, can't go
    // where we asked, and that's no reason to move everyone. It takes a seek of their own.
    const viewerSeeked = pendingSeek.seekingSeen > pendingSeek.seekingExpected;
    const landedOff = Math.abs(video.currentTime - pendingSeek.position);
    if (viewerSeeked && landedOff > OWN_SEEK_TOLERANCE_SECONDS) this.publishIfChanged();
    else this.tick();
  }

  private onRateChange(): void {
    const { video } = this;
    if (!video || Math.abs(video.playbackRate - this.expectedRate) < RATE_EPSILON) return;
    this.expectedRate = video.playbackRate;
    this.baseRate = video.playbackRate;
    this.correcting = false;
    this.publishIfChanged();
  }

  /** The player reloaded the element, so no events will come for what was in flight. */
  private onEmptied(): void {
    if (!this.video) return;
    this.clearFlags();
    this.knownPaused = this.video.paused;
    this.unreportedChangeSince = null;
    this.tick();
  }

  private consumePlayFlag(): boolean {
    const flagged = this.deps.now() < this.playFlagUntil;
    this.playFlagUntil = 0;
    return flagged;
  }

  /** Second line of defence after the flags: only real differences reach the room. */
  private publishIfChanged(): void {
    const { video, timeline } = this;
    if (!this.joined || !video) return;
    // Browsers pause a video when it's removed. Nobody chose that.
    if (!video.isConnected) return;
    if (this.refreshHold()) return;
    // A player putting the film back after an ad seeks to where it left off, which is behind
    // the room by the ad's length. That's the player, not the viewer, so the room wins.
    if (this.deps.now() - this.holdEndedAt < AFTER_HOLD_MS && !this.isViewerActing()) {
      this.apply(true);
      return;
    }
    // Not passed on, and not forced back either: the usual correction brings the video to the
    // room, and waits out an ad or a hold, which a forced one wouldn't. Alone, this video is the
    // room's timeline, so whatever it does is the room's.
    const isNewHere = this.deps.now() - this.arrivedAt < AFTER_ARRIVING_MS;
    if (isNewHere && timeline && !this.isAlone && !this.isViewerActing()) {
      if (this.inputCheckTimer !== null) return;
      this.inputCheckTimer = setTimeout(() => {
        this.inputCheckTimer = null;
        if (this.isViewerActing()) {
          this.publishIfChanged();
          return;
        }
        // The seek that brought this viewer to the room is recent, and mustn't hold this one up.
        this.lastSeekAt = Number.NEGATIVE_INFINITY;
        this.tick();
      }, INPUT_ELSEWHERE_WAIT_MS);
      return;
    }

    // Players swap a source and call play straight away, so events arrive with the position
    // at zero and no length to judge by. Nothing here says where the viewer wants to be.
    if (video.readyState < HAVE_METADATA) {
      // Pressing play on a video that loads only then is the one clear wish.
      if (timeline && !timeline.playing && !video.paused) {
        const position = targetPosition(timeline, this.deps.serverNow(), Number.POSITIVE_INFINITY);
        this.publish(position, true);
      }
      return;
    }

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
      this.publish(undefined, true);
    } else if (this.publishTimer === null) {
      // Trailing edge: dragging the seek bar sends where it ended up, not every stop.
      this.publishTimer = setTimeout(() => this.publish(undefined, true), wait);
    }
  }

  private publish(position?: number, isViewersAction = false): void {
    this.cancelPublish();
    const { video } = this;
    if (!this.joined || !video || this.isLive()) return;

    const state: PlaybackState = {
      playing: !video.paused,
      position:
        position ?? (Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0),
      rate: Math.min(MAX_RATE, Math.max(MIN_RATE, this.baseRate)),
      sentAt: this.deps.serverNow(),
      ...this.deps.filmDetails?.(),
    };
    // Only for what the viewer did. A state the engine sends to start or restore the timeline,
    // or one that changed nothing the room can name, replaces the room's whole, as before.
    const changed = isViewersAction ? this.changedFields(state) : [];
    const outgoing: OutgoingState =
      changed.length > 0 ? { ...state, changed, basis: this.lastSeq } : state;
    if (!this.deps.send(outgoing)) return;

    const change = isViewersAction && !this.isAlone ? this.describeChange(state) : null;
    const jumped = this.hasJumped(state);
    this.unacked += 1;
    this.lastPublishAt = this.deps.now();
    this.timeline = state;
    this.finishCorrection();
    if (change) this.deps.onOwnChange?.(change, { rate: state.rate, jumped });
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
    if (this.pauseCheckTimer !== null) clearTimeout(this.pauseCheckTimer);
    this.pauseCheckTimer = null;
    if (this.inputCheckTimer !== null) clearTimeout(this.inputCheckTimer);
    this.inputCheckTimer = null;
    this.finishCorrection();
    this.clearFlags();
    this.listeners?.abort();
    this.listeners = null;
  }
}
