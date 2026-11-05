// Content script, in every frame. While the tab is in a room, each frame looks for
// videos and reports its best one, and the background picks one frame to run the room
// connection and sync engine. Pages that aren't in a room get no socket and no timers.
import type { Messages } from "../i18n";
import type {
  BackgroundRequest,
  PeekReport,
  ReportResponse,
  SessionInfo,
  SessionStatus,
  TabRequest,
  TabSession,
} from "../messages";
import { formatRate } from "../format";
import { INVITE_ORIGIN, isSamePage } from "../invite";
import { roomSocketUrl } from "../settings";
import type { VideoChange } from "../video-change";
import { VideoBadge } from "./badge";
import { loadBadgePosition, saveBadgePosition } from "./badge-position";
import { VideoPicker } from "./detection/picker";
import { connectInvitePage } from "./invite-page";
import {
  forgetRemembered,
  loadRemembered,
  saveRemembered,
  selectorFor,
} from "./detection/remembered";
import { VideoTracker } from "./detection/tracker";
import { ServerClock } from "./sync/clock";
import { RoomConnection, type CloseReason, type ConnectionStatus } from "./sync/connection";
import { filmOf, isSameFilm, type Film } from "./sync/same-film";
import { SyncEngine, type PlaybackChange } from "./sync/engine";
import { ChangeNotices, type ChangeDetails } from "./sync/notices";

const isTopFrame = window === window.top;
const BADGE_UPDATE_MS = 250;
/** Sites change address without loading a page, and not always through anything hookable. */
const PAGE_CHECK_MS = 1000;
/** How often a tab with no video asks whether this is where the room's video should be. */
const ROOM_PAGE_CHECK_MS = 2000;
/** How soon a script left over from before an extension update notices and stops. */
const STILL_INSTALLED_CHECK_MS = 1000;
/** Must match the key the language switch saves under. */
const LANGUAGE_KEY = "language";

type Room = {
  engine: SyncEngine;
  sendVideo: (sealed: string) => void;
  status: () => SessionStatus;
  stop: () => void;
};

const REMOTE_CHANGE_MESSAGES: Record<PlaybackChange, string> = {
  played: "notifyPlayed",
  paused: "notifyPaused",
  seeked: "notifySeeked",
  rate: "notifyRate",
};

const OWN_CHANGE_MESSAGES: Record<PlaybackChange, string> = {
  played: "notifyYouPlayed",
  paused: "notifyYouPaused",
  seeked: "notifyYouSeeked",
  rate: "notifyYouRate",
};

type RoomHooks = {
  onRemoteChange: (change: PlaybackChange, details: ChangeDetails) => void;
  onOwnChange: (change: PlaybackChange, details: ChangeDetails) => void;
  onRoomVideo: (sealed: string, announced: boolean) => void;
  onPeopleChange: (count: number) => void;
  onOthersAdEnded: () => void;
  isOnOtherVideo: () => boolean;
  videoChange: () => VideoChange | null;
  isFilmStillPlaying: () => boolean;
  isOnRoomPage: () => boolean;
};

function startRoom({ code, serverUrl }: TabSession, tracker: VideoTracker, hooks: RoomHooks): Room {
  const clock = new ServerClock();
  let connectionStatus: ConnectionStatus = "connecting";
  let closeReason: CloseReason | null = null;
  let peers = 0;
  let othersOnAd = 0;
  let isOnAd = false;

  const engine = new SyncEngine({
    now: Date.now,
    serverNow: () => Date.now() + clock.offset,
    send: (state) => connection.sendState(state),
    holdFor: (roomPosition) =>
      hooks.isOnOtherVideo() ? "other_video" : tracker.holdReason(roomPosition, peers > 1),
    onRemoteChange: hooks.onRemoteChange,
    onOwnChange: hooks.onOwnChange,
    onHoldChange: (hold) => {
      isOnAd = hold === "ad";
      connection.sendAdState(isOnAd);
    },
  });
  const connection = new RoomConnection({
    url: roomSocketUrl(serverUrl, code),
    clock,
    events: {
      onJoined: (message) => {
        peers = message.peers;
        hooks.onPeopleChange(peers);
        othersOnAd = message.ads ?? 0;
        if (message.video) hooks.onRoomVideo(message.video, false);
        engine.handleJoined(message);
        // The room forgot this along with the old connection.
        if (isOnAd) connection.sendAdState(true);
      },
      onState: (state) => engine.handleState(state),
      onPeers: (count) => {
        peers = count;
        hooks.onPeopleChange(count);
        engine.handlePeers(count);
      },
      onAds: (count) => {
        const hadAny = othersOnAd > 0;
        othersOnAd = count;
        if (hadAny && count === 0) hooks.onOthersAdEnded();
      },
      onVideo: (sealed) => hooks.onRoomVideo(sealed, true),
      onRejected: () => engine.handleRejected(),
      onDisconnected: () => engine.handleDisconnected(),
      onStatus: (status, reason) => {
        connectionStatus = status;
        closeReason = reason;
        if (status !== "connected") hooks.onPeopleChange(0);
      },
    },
  });

  engine.bind(tracker.video());
  const onOnline = () => connection.retryNow();
  window.addEventListener("online", onOnline);
  connection.start();

  return {
    engine,
    sendVideo: (sealed) => void connection.sendVideo(sealed),
    status: () => ({
      ...engine.snapshot(),
      connection: connectionStatus,
      closeReason,
      peers,
      othersOnAd,
      videoChange: hooks.videoChange(),
      isFilmStillPlaying: hooks.isFilmStillPlaying(),
      isOnRoomPage: hooks.isOnRoomPage(),
    }),
    stop: () => {
      window.removeEventListener("online", onOnline);
      connection.stop();
      engine.stop();
    },
  };
}

/** Browsers leave content scripts running when their extension is updated or reloaded. */
function isStillInstalled(): boolean {
  return chrome.runtime?.id !== undefined;
}

function send<T>(request: BackgroundRequest): Promise<T | undefined> {
  // Failing, by throwing or rejecting, means this script is left over from before an update.
  try {
    return chrome.runtime.sendMessage<BackgroundRequest, T>(request).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

/** This frame's part in a room: always looking for videos, sometimes running the sync. */
class FrameSession {
  readonly tracker: VideoTracker;
  private room: Room | null = null;
  private isStopped = false;
  private badge: VideoBadge | null = null;
  private badgeTimer: ReturnType<typeof setInterval> | null = null;
  private pageTimer: ReturnType<typeof setInterval> | null = null;
  private readonly installedTimer: ReturnType<typeof setInterval>;
  private readonly remoteNotices = new ChangeNotices((change, rate) => {
    // It's about a video this viewer isn't on.
    if (!this.isOnOtherVideo()) {
      this.badge?.flash(REMOTE_CHANGE_MESSAGES[change], [formatRate(rate)]);
    }
  });
  private readonly ownNotices = new ChangeNotices((change, rate) => {
    this.badge?.flash(OWN_CHANGE_MESSAGES[change], [formatRate(rate)]);
  });
  private lastPageReport = "";
  private lastPageUrl: string | null = null;
  private isOnRoomPage = false;
  private lastRoomPageCheck = Number.NEGATIVE_INFINITY;
  private videoChange: VideoChange | null = null;
  /** What was playing while this tab was last on the room's video. */
  private followedFilm: Film | null = null;
  /**
   * Questions out to the background about a new page or an announced video. Until they're
   * answered this could be the wrong film, so nothing is done to it.
   */
  private checksPending = 0;
  /** Our own announcement comes back like anyone else's. */
  private lastSealedSent: string | null = null;
  /**
   * The page may be kept frozen for the back button, sockets and all, and a frozen page
   * would go on counting as someone in the room. Coming back asks for its role again.
   */
  private readonly onPageHide = () => {
    this.report(0);
    this.setActive(false);
  };
  private readonly onStorageChange = (changes: Record<string, chrome.storage.StorageChange>) => {
    if (LANGUAGE_KEY in changes && this.room) {
      this.stopBadge();
      void this.startBadge();
    }
  };

  constructor(readonly session: TabSession) {
    this.tracker = new VideoTracker({
      onVideoChange: (video) => {
        // Rebinding also covers a new film in the same element, which binding alone ignores.
        this.room?.engine.bind(null);
        this.room?.engine.bind(video);
      },
      onReport: (score) => this.report(score),
    });
    window.addEventListener("pagehide", this.onPageHide);
    chrome.storage.onChanged.addListener(this.onStorageChange);
    this.installedTimer = setInterval(() => {
      if (!isStillInstalled()) this.stop();
    }, STILL_INSTALLED_CHECK_MS);
    if (isTopFrame) {
      this.reportPage();
      this.pageTimer = setInterval(() => this.reportPage(), PAGE_CHECK_MS);
    }
    void loadRemembered(location.hostname)
      .catch(() => null)
      .then((selector) => {
        if (!this.isStopped) this.tracker.start(selector);
      });
  }

  setActive(active: boolean): void {
    if (active && !this.room) {
      this.room = startRoom(this.session, this.tracker, {
        onRemoteChange: (change, details) => this.remoteNotices.add(change, details),
        onOwnChange: (change, details) => this.ownNotices.add(change, details),
        onOthersAdEnded: () => this.badge?.flash("notifyAdEnded"),
        onRoomVideo: (sealed, announced) => this.onRoomVideo(sealed, announced),
        onPeopleChange: (count) => void send({ type: "room/people", count }),
        isOnOtherVideo: () => this.isOnOtherVideo(),
        videoChange: () => (this.isFilmStillPlaying() ? null : this.videoChange),
        isFilmStillPlaying: () => this.isFilmStillPlaying(),
        isOnRoomPage: () => this.isOnRoomPage,
      });
      void this.startBadge();
    } else if (!active && this.room) {
      this.remoteNotices.stop();
      this.ownNotices.stop();
      this.stopBadge();
      this.room.stop();
      this.room = null;
    }
  }

  status(): SessionStatus | null {
    return this.room?.status() ?? null;
  }

  setVideoChange(change: VideoChange | null): void {
    this.videoChange = change;
    this.room?.engine.recheck();
  }

  /** Lifts the hold first, because the engine won't speak for a video that's on hold. */
  bringEveryone(sealed: string | null): void {
    this.videoChange = null;
    if (sealed) {
      this.lastSealedSent = sealed;
      this.room?.sendVideo(sealed);
    }
    this.room?.engine.bringEveryone();
  }

  moveBadge(): void {
    this.badge?.startMoving();
  }

  stop(): void {
    this.isStopped = true;
    clearInterval(this.installedTimer);
    window.removeEventListener("pagehide", this.onPageHide);
    if (this.pageTimer !== null) clearInterval(this.pageTimer);
    this.setActive(false);
    this.tracker.stop();
    // Last, because it can throw in a script left over from before an update.
    if (isStillInstalled()) chrome.storage.onChanged.removeListener(this.onStorageChange);
  }

  /** Looks at the address each time, so a site changing film is caught before it's touched. */
  private isOnOtherVideo(): boolean {
    this.reportPage();
    if (this.videoChange === null && this.checksPending === 0) {
      this.followedFilm = filmOf(this.tracker.video()) ?? this.followedFilm;
    }
    if (this.isFilmStillPlaying()) return false;
    return this.videoChange !== null || this.checksPending > 0;
  }

  /** Only for having moved: when the room moves, staying on the old film is the problem. */
  private isFilmStillPlaying(): boolean {
    return (
      this.videoChange?.kind === "you_moved" &&
      isSameFilm(this.followedFilm, filmOf(this.tracker.video()))
    );
  }

  private whenAnswered(answer: Promise<VideoChange | null | undefined>): void {
    this.checksPending += 1;
    void answer.then((change) => {
      this.checksPending -= 1;
      if (!this.isStopped) this.setVideoChange(change ?? null);
    });
  }

  private onRoomVideo(sealed: string, announced: boolean): void {
    if (sealed === this.lastSealedSent) return;
    const answer = send<VideoChange | null>({ type: "video/seen", sealed, announced });
    // Someone who announced a video has its state right behind it. Joining brings the state along.
    if (announced) {
      this.whenAnswered(answer);
    } else {
      void answer.then((change) => {
        if (!this.isStopped) this.setVideoChange(change ?? null);
      });
    }
  }

  /** Only the top frame's address says what page this is. It stays inside the extension. */
  private reportPage(): void {
    const { href: url } = location;
    const { title } = document;
    const report = `${url} ${title}`;
    if (!isTopFrame || report === this.lastPageReport) return;
    this.lastPageReport = report;

    const answer = send<VideoChange | null>({ type: "page/report", url, title });
    if (isSamePage(this.lastPageUrl, url)) return;
    this.lastPageUrl = url;
    this.whenAnswered(answer);
  }

  private async startBadge(): Promise<void> {
    const [messages, position] = await Promise.all([
      send<Messages>({ type: "i18n/messages" }),
      loadBadgePosition(location.hostname).catch(() => null),
    ]);
    if (!messages || !this.room || this.badge) return;

    this.badge = new VideoBadge({
      messages,
      position,
      onPlay: () => this.room?.engine.retryPlay(),
      onBring: () => void send({ type: "video/bring" }),
      onGo: () => void send({ type: "video/go" }),
      onLeave: () => void send({ type: "session/leave" }),
      onPause: () => this.tracker.video()?.pause(),
      onPositionChange: (moved) => void saveBadgePosition(location.hostname, moved),
    });
    this.badgeTimer = setInterval(() => {
      this.checkRoomPage();
      this.badge?.update(this.tracker.video(), this.room?.status() ?? null);
    }, BADGE_UPDATE_MS);
  }

  /** Only while it matters, since a tab with a video has no use for the answer. */
  private checkRoomPage(): void {
    const now = Date.now();
    if (this.tracker.video() || now - this.lastRoomPageCheck < ROOM_PAGE_CHECK_MS) return;
    this.lastRoomPageCheck = now;
    void send<boolean>({ type: "video/on-room-page" }).then((answer) => {
      this.isOnRoomPage = answer === true;
    });
  }

  private stopBadge(): void {
    if (this.badgeTimer !== null) clearInterval(this.badgeTimer);
    this.badgeTimer = null;
    this.badge?.stop();
    this.badge = null;
  }

  private report(score: number): void {
    // First, so a video found on a new page isn't counted for the page it just left.
    this.reportPage();
    void send<ReportResponse>({ type: "detect/report", score }).then((response) => {
      if (response && !this.isStopped) this.setActive(response.active);
    });
  }
}

let frameSession: FrameSession | null = null;
let picker: VideoPicker | null = null;
/** Set in the frame where the viewer picked, so it keeps the pick when the picker closes. */
let pickedHere = false;

function applySession(session: TabSession | null): void {
  const current = frameSession?.session;
  if (current && session?.code === current.code && session.serverUrl === current.serverUrl) return;
  frameSession?.stop();
  frameSession = session ? new FrameSession(session) : null;
}

/** A one-off look for the popup, which also asks before any room exists. */
function peek(): PeekReport {
  let score = 0;
  const tracker = new VideoTracker({
    onVideoChange: () => undefined,
    onReport: (reported) => {
      score = reported;
    },
  });
  tracker.start(null);
  const duration = tracker.video()?.duration ?? null;
  tracker.stop();
  return {
    score,
    duration: duration !== null && Number.isFinite(duration) ? duration : null,
    title: isTopFrame ? document.title : null,
    url: isTopFrame ? location.href : null,
  };
}

function startPicker(messages: Extract<TabRequest, { type: "picker/start" }>["messages"]): void {
  picker?.stop();
  picker = new VideoPicker(messages, {
    onPick: (video) => {
      pickedHere = true;
      frameSession?.tracker.setPicked(video);
      void saveRemembered(location.hostname, selectorFor(video));
      void send({ type: "picker/picked" });
    },
    onCancel: () => void send({ type: "picker/cancelled" }),
  });
  picker.start();
}

function stopPicker(picked: boolean): void {
  picker?.stop();
  picker = null;
  // The viewer chose a video in another frame, which replaces any earlier choice here.
  if (picked && !pickedHere) {
    frameSession?.tracker.setPicked(null);
    void forgetRemembered(location.hostname);
  }
  pickedHere = false;
}

function start(): void {
  chrome.runtime.onMessage.addListener((request: TabRequest, _sender, sendResponse) => {
    switch (request.type) {
      case "session/changed":
        applySession(request.session);
        return;
      case "session/role":
        frameSession?.setActive(request.active);
        return;
      case "session/status": {
        // Only one frame answers: the one running the room, or the top one if none is.
        const status = frameSession?.status() ?? null;
        if (status || (isTopFrame && !frameSession)) sendResponse(status);
        return;
      }
      case "session/bring":
        frameSession?.bringEveryone(request.sealed);
        return;
      case "session/video-change":
        frameSession?.setVideoChange(request.change);
        return;
      case "badge/move":
        frameSession?.moveBadge();
        return;
      case "detect/peek": {
        const report = peek();
        // Frames with nothing to add stay quiet. The top frame always answers, for the title.
        if (isTopFrame || report.score > 0) void send({ type: "detect/peeked", report });
        return;
      }
      case "picker/start":
        startPicker(request.messages);
        return;
      case "picker/stop":
        stopPicker(request.picked);
        return;
    }
  });

  if (isTopFrame && location.origin === INVITE_ORIGIN) {
    connectInvitePage((request) => send(request));
  }

  function syncWithBackground(): void {
    void send<SessionInfo>({ type: "session/get" }).then((info) => {
      if (!info) return;
      applySession(info.session);
      frameSession?.setVideoChange(info.videoChange);
      frameSession?.setActive(info.active);
    });
  }

  syncWithBackground();

  // Back from being kept for the back button. The room may have changed meanwhile.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) syncWithBackground();
  });
}

// The popup adds this script to a tab that didn't answer, which a slow page might yet do.
// A copy left over from before an update doesn't count, since it has stopped.
const RUNNING = Symbol.for("sinkro.content");
const page = window as unknown as Record<symbol, (() => boolean) | undefined>;
if (page[RUNNING]?.() !== true) {
  page[RUNNING] = isStillInstalled;
  start();
}
