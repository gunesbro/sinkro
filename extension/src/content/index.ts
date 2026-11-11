// Content script, in every frame. While the tab is in a room, each frame looks for
// videos and reports its best one, and the background picks one frame to run the room
// connection and sync engine. Pages that aren't in a room get no socket and no timers.
import type { Messages } from "../i18n";
import type { Film as FilmDetails, Person, RoomState } from "../../../server/src/protocol";
import {
  forgetNamesOfThoseGone,
  isOwnNameChange,
  nameText,
  namesInRoom,
  type NamePick,
} from "../names";
import type {
  BackgroundRequest,
  SourceMismatch,
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
import { noticeFor } from "../status";
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
import {
  isFloatingPlayer,
  isHoverPreview,
  isPreviewLike,
  isPreviewSized,
} from "./detection/floating";
import { VideoTracker } from "./detection/tracker";
import { VideoLengths } from "./detection/length";
import { differentFilm, SAME_LENGTH_SECONDS, type OthersFilm } from "./sync/film-match";
import { isMarkedLive } from "../adapters/live";
import { ServerClock } from "./sync/clock";
import { RoomConnection, type CloseReason, type ConnectionStatus } from "./sync/connection";
import { filmOf, isSameFilm, type Film } from "./sync/same-film";
import { SyncEngine, type PlaybackChange } from "./sync/engine";
import { ChangeNotices, type ChangeDetails } from "./sync/notices";
import { Arrivals } from "./sync/arrivals";

const isTopFrame = window === window.top;
const BADGE_UPDATE_MS = 250;
/** Input is passed to the tab's other frames at most this often. */
const INPUT_SHARE_MS = 250;
/** How soon to try again when the badge couldn't get its words from the background. */
const BADGE_RETRY_MS = 1000;
/** How often a viewer looks at their own drift. Looking is free; telling the room isn't. */
const DRIFT_CHECK_MS = 5000;
/**
 * A drift is told once after each change of state, then only when it's moved this much: every
 * message counts against the server's daily quota, and a steady drift has nothing new to say.
 */
const DRIFT_STEP_SECONDS = 0.03;
/** Right after a change of state, drift is about the seek still landing, not the viewer. */
const DRIFT_SETTLE_MS = 2000;
/** Past this the engine seeks, so the drift is about to vanish rather than worth telling. */
const DRIFT_SEEKING_SECONDS = 2;
/** How often a viewer looks at whether their film changed. Looking is free. */
const FILM_CHECK_MS = 1000;
/** How often a viewer looks at whether they've come to the room's video. Looking is free. */
const BEHIND_CHECK_MS = 1000;
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
  /** Everyone in the room by id, with their name's picks once opened. */
  people: () => { id: string; pick: NamePick | null; isYou: boolean }[];
  /** Tells the room this browser's name again, after it changed. */
  resendName: () => void;
  /** Puts away "not everyone's here" until the count changes. */
  dismissBehind: () => void;
  sendVideo: (sealed: string, fresh: boolean) => void;
  status: () => SessionStatus;
  stop: () => void;
};

const REMOTE_CHANGE_MESSAGES: Record<PlaybackChange, string> = {
  played: "notifyPlayed",
  paused: "notifyPaused",
  seeked: "notifySeeked",
  rate: "notifyRate",
};

const NAMED_CHANGE_MESSAGES: Record<PlaybackChange, string> = {
  played: "notifyByPlayed",
  paused: "notifyByPaused",
  seeked: "notifyBySeeked",
  rate: "notifyByRate",
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
  onEveryoneArrived: () => void;
  isOnOtherVideo: () => boolean;
  videoChange: () => VideoChange | null;
  isFilmStillPlaying: () => boolean;
  isOnRoomPage: () => boolean;
  isHoverPreview: () => boolean;
  /** Someone else's state, for what it says about their film. */
  onOthersState: (state: RoomState) => void;
  filmDetails: () => Pick<RoomState, "duration" | "source">;
  lastInputAt: () => number;
  lastInputHereAt: () => number;
  sourceMismatch: () => SourceMismatch | null;
  isLive: () => boolean;
  /** What film this viewer has, to tell the room. */
  film: () => FilmDetails;
  onFilms: (films: OthersFilm[]) => void;
  /** This browser's name sealed for the room, through the background, which has the code. */
  sealName: () => Promise<string | null | undefined>;
  openNames: (sealed: string[]) => Promise<(NamePick | null)[] | undefined>;
};

/** Long enough for someone back from an ad to have told the room their film again. */
const AFTER_OTHERS_AD_MS = 15_000;

/** Names seen in one room are few, but a room can run for hours of people coming and going. */
const MAX_OPENED_NAMES = 200;

function startRoom({ code, serverUrl }: TabSession, tracker: VideoTracker, hooks: RoomHooks): Room {
  const clock = new ServerClock();
  let connectionStatus: ConnectionStatus = "connecting";
  let closeReason: CloseReason | null = null;
  let peers = 0;
  let othersOnAd = 0;
  /** When someone else was last seen on an ad, or just came off one. */
  let othersAdSeenAt = Number.NEGATIVE_INFINITY;
  let ownId: string | null = null;
  let spread: number | null = null;
  let lastDriftSent: number | null = null;
  let lastStateAt = 0;
  // The room forgets everyone's drift on each change of state, and with an old connection.
  const tellDriftAgain = () => {
    lastDriftSent = null;
    lastStateAt = Date.now();
  };
  let isOnAd = false;
  let othersBehind = 0;
  let dismissedBehind: number | null = null;
  let isBehind = false;
  /** What this viewer last told the room about their film, or null to tell it again. */
  let lastFilmSent: string | null = null;
  let people: Person[] = [];
  /** What each sealed name opened to, so the list that follows every change isn't opened again. */
  const openedNames = new Map<string, NamePick | null>();
  /** Whether this connection has told the room this viewer's name. */
  let isNameSent = false;
  const sendName = () => {
    isNameSent = true;
    void hooks.sealName().then((sealed) => {
      if (!sealed || !connection.sendName(sealed)) isNameSent = false;
    });
  };
  const openNames = (list: Person[]) => {
    const unopened = list.flatMap((person) =>
      person.name && !openedNames.has(person.name) ? [person.name] : [],
    );
    if (unopened.length === 0) return;
    if (openedNames.size > MAX_OPENED_NAMES) {
      forgetNamesOfThoseGone(
        openedNames,
        list.flatMap((person) => person.name ?? []),
      );
    }
    void hooks.openNames(unopened).then((picks) => {
      unopened.forEach((sealed, index) => openedNames.set(sealed, picks?.[index] ?? null));
    });
  };
  const arrivals = new Arrivals({
    onEveryoneHere: hooks.onEveryoneArrived,
    isHere: () => hooks.videoChange() === null,
  });

  const engine = new SyncEngine({
    now: Date.now,
    serverNow: () => Date.now() + clock.offset,
    send: (state) => connection.sendState(state),
    holdFor: (roomPosition) =>
      hooks.isOnOtherVideo() ? "other_video" : tracker.holdReason(roomPosition, peers > 1),
    onRemoteChange: hooks.onRemoteChange,
    onOwnChange: hooks.onOwnChange,
    filmDetails: hooks.filmDetails,
    lastInputAt: hooks.lastInputAt,
    lastInputHereAt: hooks.lastInputHereAt,
    isLive: hooks.isLive,
    onHoldChange: (hold) => {
      // A film that can't follow is usually a player's ad without markers, as far as others care.
      const wasOnAd = isOnAd;
      isOnAd = hold === "ad" || hold === "cant_follow";
      connection.sendAdState(isOnAd);
      // What the player has during an ad is the ad. Once it's over, the film is told again.
      if (wasOnAd && !isOnAd) lastFilmSent = null;
    },
  });
  const connection = new RoomConnection({
    url: roomSocketUrl(serverUrl, code),
    clock,
    events: {
      onJoined: (message) => {
        peers = message.peers;
        arrivals.setPeers(peers);
        ownId = message.clientId;
        if (message.state && message.state.from !== ownId) hooks.onOthersState(message.state);
        hooks.onPeopleChange(peers);
        othersOnAd = message.ads ?? 0;
        if (message.video) hooks.onRoomVideo(message.video, false);
        engine.handleJoined(message);
        tellDriftAgain();
        // The room forgot these along with the old connection.
        if (isOnAd) connection.sendAdState(true);
        if (isBehind) connection.sendBehind(true);
        lastFilmSent = null;
        othersBehind = 0;
        // A new connection: the room knows nothing of this one's name yet.
        isNameSent = false;
        people = [];
      },
      onState: (state) => {
        if (state.from !== ownId) hooks.onOthersState(state);
        engine.handleState(state);
        tellDriftAgain();
      },
      onPeers: (count) => {
        peers = count;
        hooks.onPeopleChange(count);
        engine.handlePeers(count);
        arrivals.setPeers(count);
      },
      onFilms: (films) => hooks.onFilms(films),
      // Only a room that keeps names sends this, so a name is never sent to one that doesn't.
      onPeople: (list) => {
        people = list;
        if (!isNameSent) sendName();
        openNames(list);
      },
      onLeftBehind: (count) => {
        if (count !== othersBehind) dismissedBehind = null;
        othersBehind = count;
        arrivals.setOthersAway(count);
      },
      onSpread: (seconds) => {
        spread = seconds;
      },
      onAds: (count) => {
        const hadAny = othersOnAd > 0;
        othersOnAd = count;
        if (hadAny || count > 0) othersAdSeenAt = Date.now();
        if (hadAny && count === 0) hooks.onOthersAdEnded();
      },
      onVideo: (sealed, fresh) => {
        if (fresh) engine.forgetTimeline();
        arrivals.roomMoved();
        hooks.onRoomVideo(sealed, true);
      },
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
  // Each viewer only knows their own drift, so they tell the room, which says how far apart
  // the furthest two are. It's only for showing: each viewer corrects their own drift without it.
  // A paused room or one on hold has nothing to say.
  const driftTimer = setInterval(() => {
    const { drift, hold, paused } = engine.snapshot();
    if (drift === null || hold || paused || connectionStatus !== "connected") return;
    if (Date.now() - lastStateAt < DRIFT_SETTLE_MS || Math.abs(drift) > DRIFT_SEEKING_SECONDS) {
      return;
    }
    if (lastDriftSent !== null && Math.abs(drift - lastDriftSent) < DRIFT_STEP_SECONDS) return;
    const rounded = Math.round(drift * 1000) / 1000;
    if (connection.sendDrift(rounded)) lastDriftSent = rounded;
  }, DRIFT_CHECK_MS);
  // Only a yes or no, so the others can tell who's with them. Which page this is stays here: its
  // address only leaves when someone brings everyone to it. A miniplayer still playing the
  // film has no video change, so it counts as here.
  // Told when it changes, so a switch to another player is known without anyone pressing play.
  const filmTimer = setInterval(() => {
    if (connectionStatus !== "connected" || isOnAd) return;
    const film = hooks.film();
    const key = JSON.stringify([
      film.duration === undefined ? null : Math.round(film.duration),
      film.source ?? null,
    ]);
    if (key !== lastFilmSent && connection.sendFilm(film)) lastFilmSent = key;
  }, FILM_CHECK_MS);
  const behindTimer = setInterval(() => {
    const behind = hooks.videoChange() !== null;
    if (behind === isBehind || connectionStatus !== "connected") return;
    if (connection.sendBehind(behind)) isBehind = behind;
  }, BEHIND_CHECK_MS);
  const onOnline = () => connection.retryNow();
  window.addEventListener("online", onOnline);
  connection.start();

  const namedPeople = () =>
    people.map(({ id, name }) => ({
      id,
      pick: (name && openedNames.get(name)) || null,
      isYou: id === ownId,
    }));

  return {
    engine,
    people: namedPeople,
    resendName: () => {
      if (connectionStatus === "connected" && people.length > 0) sendName();
    },
    sendVideo: (sealed, fresh) => void connection.sendVideo(sealed, fresh),
    dismissBehind: () => {
      dismissedBehind = othersBehind;
    },
    status: () => ({
      ...engine.snapshot(),
      // Nobody came to watch this, so as far as anyone's told there's no video here.
      ...(hooks.isHoverPreview() ? { hasVideo: false, position: null, drift: null } : {}),
      connection: connectionStatus,
      closeReason,
      peers,
      othersOnAd,
      othersBehind,
      isBehindDismissed: othersBehind === dismissedBehind,
      spread: peers > 1 ? spread : null,
      // An ad has a length of its own, and an older version tells the room about it: while
      // anyone's on one, and for a moment after, while they say their film again, lengths wait.
      sourceMismatch:
        engine.snapshot().hold || othersOnAd > 0 || Date.now() - othersAdSeenAt < AFTER_OTHERS_AD_MS
          ? null
          : hooks.sourceMismatch(),
      videoChange: hooks.videoChange(),
      isFilmStillPlaying: hooks.isFilmStillPlaying(),
      isOnRoomPage: hooks.isOnRoomPage(),
      isFloatingPlayer: isFloatingPlayer(tracker.video()),
      isPreviewLike: previewLike(tracker.video()),
      people: namedPeople().map(({ pick, isYou }) => ({ pick, isYou })),
    }),
    stop: () => {
      clearInterval(driftTimer);
      clearInterval(behindTimer);
      clearInterval(filmTimer);
      window.removeEventListener("online", onOnline);
      connection.stop();
      engine.stop();
    },
  };
}

function previewLike(video: HTMLVideoElement | null): boolean {
  return (
    video !== null && isPreviewLike(video, { width: window.innerWidth, height: window.innerHeight })
  );
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
  private badgeRetry: ReturnType<typeof setTimeout> | null = null;
  private pageTimer: ReturnType<typeof setInterval> | null = null;
  private readonly installedTimer: ReturnType<typeof setInterval>;
  private readonly remoteNotices = new ChangeNotices((change, rate, by) => {
    // It's about a video this viewer isn't on.
    if (this.isOnOtherVideo()) return;
    const name = by === null ? null : this.nameOf(by);
    if (name) this.badge?.flash(NAMED_CHANGE_MESSAGES[change], [name, formatRate(rate)]);
    else this.badge?.flash(REMOTE_CHANGE_MESSAGES[change], [formatRate(rate)]);
  });
  /** The language's messages, once the badge has loaded them. */
  private messages: Messages | null = null;
  private readonly ownNotices = new ChangeNotices((change, rate) => {
    this.badge?.flash(OWN_CHANGE_MESSAGES[change], [formatRate(rate)]);
  });
  private lastPageReport = "";
  private lastPageUrl: string | null = null;
  private pointer: { x: number; y: number } | null = null;
  /** When the viewer last clicked or pressed a key here, to tell their changes from a player's. */
  private lastInputAt = Number.NEGATIVE_INFINITY;
  /** The latest click or key in any frame of this tab, as the background passed it on. */
  private tabInputAt = Number.NEGATIVE_INFINITY;
  private lastInputShared = Number.NEGATIVE_INFINITY;
  private readonly clickedVideos = new WeakSet<HTMLVideoElement>();
  private readonly previews = new WeakSet<HTMLVideoElement>();
  private readonly pointerListeners = new AbortController();
  private isOnRoomPage = false;
  /** The length and sealed player of the film others last said they're on. */
  private othersFilm: { duration: number | null; source: string | null } = {
    duration: null,
    source: null,
  };
  private readonly openedSources = new Map<string, string | null>();
  /**
   * The films the others on the room's video say they have. Null until the room says, as an
   * older server never does: then the last state someone sent is all there is to go on.
   */
  private othersFilms: OthersFilm[] | null = null;
  private ownSource: { host: string; sealed: string } | null = null;
  private isSealingSource = false;
  private dismissedMismatch: string | null = null;
  private readonly lengths = new VideoLengths(
    Date.now,
    () => location.pathname + location.search,
    (video) => video instanceof Element && isMarkedLive(video),
  );
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
    if (isOwnNameChange(changes)) this.room?.resendName();
  };

  /** Someone's name as everyone in the room sees it, with a number if two drew the same. */
  private nameOf(id: string): string | null {
    const { messages, room } = this;
    if (!messages || !room) return null;
    const people = room.people();
    const shown = namesInRoom(
      people.map(({ pick }) => (pick === null ? null : nameText(pick, messages))),
    );
    return shown[people.findIndex((person) => person.id === id)] ?? null;
  }

  constructor(readonly session: TabSession) {
    this.tracker = new VideoTracker({
      onVideoChange: (video) => {
        // Rebinding also covers a new film in the same element, which binding alone ignores.
        this.room?.engine.bind(null);
        this.room?.engine.bind(video);
      },
      onReport: (score) => this.report(this.isHoverPreview() ? 0 : score),
    });
    window.addEventListener("pagehide", this.onPageHide);
    chrome.storage.onChanged.addListener(this.onStorageChange);
    // It goes into the page's own world, where a site could notice it, so only rooms get it.
    void send({ type: "hook/install" });
    const { signal } = this.pointerListeners;
    const notePointer = (event: PointerEvent) => {
      this.pointer = { x: event.clientX, y: event.clientY };
    };
    // Over as well as move, because it comes first: a page starts a preview on mouseenter, which
    // goes ahead of the move, and the engine asks about the video the moment it starts.
    window.addEventListener("pointerover", notePointer, { capture: true, passive: true, signal });
    window.addEventListener("pointermove", notePointer, { capture: true, passive: true, signal });
    const noteInput = () => {
      this.lastInputAt = Date.now();
      // Others in the tab may hold the video this was meant for. A burst of keys is one input.
      if (this.lastInputAt - this.lastInputShared > INPUT_SHARE_MS) {
        this.lastInputShared = this.lastInputAt;
        void send({ type: "input/note" });
      }
    };
    window.addEventListener("keydown", noteInput, { capture: true, passive: true, signal });
    window.addEventListener(
      "pointerdown",
      (event) => {
        noteInput();
        notePointer(event);
        const video = this.tracker.video();
        if (video && this.isPointerOver(video)) this.clickedVideos.add(video);
      },
      { capture: true, passive: true, signal },
    );
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

  noteTabInput(at: number): void {
    this.tabInputAt = Math.max(this.tabInputAt, at);
  }

  setActive(active: boolean): void {
    if (active && !this.room) {
      this.room = startRoom(this.session, this.tracker, {
        onRemoteChange: (change, details) => this.remoteNotices.add(change, details),
        onOwnChange: (change, details) => this.ownNotices.add(change, details),
        onOthersAdEnded: () => this.badge?.flash("notifyAdEnded"),
        onEveryoneArrived: () => this.badge?.flash("notifyEveryoneHere"),
        onRoomVideo: (sealed, announced) => this.onRoomVideo(sealed, announced),
        onPeopleChange: (count) => void send({ type: "room/people", count }),
        isOnOtherVideo: () => this.isOnOtherVideo(),
        videoChange: () => (this.isFilmStillPlaying() ? null : this.videoChange),
        isFilmStillPlaying: () => this.isFilmStillPlaying(),
        isOnRoomPage: () => this.isOnRoomPage,
        isHoverPreview: () => this.isHoverPreview(),
        onOthersState: (state) => this.onOthersState(state),
        filmDetails: () => this.filmDetails(),
        lastInputAt: () => Math.max(this.lastInputAt, this.tabInputAt),
        lastInputHereAt: () => this.lastInputAt,
        sourceMismatch: () => this.sourceMismatch(),
        film: () => this.ownFilm(),
        onFilms: (films) => this.onFilms(films),
        sealName: () => send<string | null>({ type: "name/seal" }),
        openNames: (sealed) => send<(NamePick | null)[]>({ type: "name/open", sealed }),
        isLive: () => {
          const video = this.tracker.video();
          return video !== null && this.lengths.isLive(video);
        },
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
  bringEveryone(sealed: string | null, isNewFilm: boolean): void {
    this.videoChange = null;
    // What the others last said was about the old film, so its length means nothing here.
    if (isNewFilm) this.othersFilm = { duration: null, source: null };
    if (sealed) {
      this.lastSealedSent = sealed;
      this.room?.sendVideo(sealed, isNewFilm);
    }
    this.room?.engine.bringEveryone(isNewFilm);
  }

  moveBadge(): void {
    this.badge?.startMoving();
  }

  stop(): void {
    this.isStopped = true;
    clearInterval(this.installedTimer);
    this.pointerListeners.abort();
    window.removeEventListener("pagehide", this.onPageHide);
    if (this.pageTimer !== null) clearInterval(this.pageTimer);
    this.setActive(false);
    this.tracker.stop();
    // Last, because it can throw in a script left over from before an update.
    if (isStillInstalled()) chrome.storage.onChanged.removeListener(this.onStorageChange);
  }

  private isPointerOver(video: HTMLVideoElement): boolean {
    if (!this.pointer) return false;
    const box = video.getBoundingClientRect();
    const { x, y } = this.pointer;
    return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  }

  private isHoverPreview(): boolean {
    const video = this.tracker.video();
    if (!video) return false;
    const isPreview = isHoverPreview({
      muted: video.muted || video.volume === 0,
      isSmall: isPreviewSized(video.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
      isPointerOver: this.isPointerOver(video),
      wasClicked: this.clickedVideos.has(video),
      position: video.currentTime,
      wasPreview: this.previews.has(video),
    });
    if (isPreview) this.previews.add(video);
    else this.previews.delete(video);
    return isPreview;
  }

  private onOthersState(state: RoomState): void {
    const source = state.source ?? null;
    this.othersFilm = { duration: state.duration ?? null, source };
    this.openSource(source);
  }

  private onFilms(films: OthersFilm[]): void {
    this.othersFilms = films;
    for (const film of films) this.openSource(film.source ?? null);
  }

  /** Learns which site a sealed player is from, once, for naming it in the warning. */
  private openSource(source: string | null): void {
    if (!source || this.openedSources.has(source)) return;
    this.openedSources.set(source, null);
    void send<string | null>({ type: "source/open", sealed: source }).then((host) => {
      this.openedSources.set(source, host ?? null);
    });
  }

  /** A length only once it has settled, and none for a live stream, so others compare like for like. */
  private ownFilm(): FilmDetails {
    const video = this.tracker.video();
    const duration = video && !this.isHoverPreview() ? this.lengths.settledLength(video) : null;
    const { source } = this.filmDetails();
    return { ...(duration !== null ? { duration } : {}), ...(source ? { source } : {}) };
  }

  /** The player's site is this frame's, since it's the one holding the video. */
  private filmDetails(): Pick<RoomState, "duration" | "source"> {
    const host = location.hostname;
    if (this.ownSource?.host !== host && !this.isSealingSource && host) {
      this.isSealingSource = true;
      void send<string | null>({ type: "source/seal", host }).then((sealed) => {
        this.isSealingSource = false;
        if (sealed) this.ownSource = { host, sealed };
      });
    }
    const video = this.tracker.video();
    // A live stream's length says nothing about which film this is.
    const duration = video && !this.lengths.isLive(video) ? video.duration : undefined;
    return {
      ...(duration !== undefined && Number.isFinite(duration) && duration > 0 ? { duration } : {}),
      ...(this.ownSource?.host === host ? { source: this.ownSource.sealed } : {}),
    };
  }

  private mismatchKey(mine: number, room: number): string {
    return `${Math.round(mine)}|${Math.round(room)}`;
  }

  /** Same length means the same moments line up, whichever source it is, so that's fine. */
  private sourceMismatch(): SourceMismatch | null {
    const video = this.tracker.video();
    // A live stream's length is how far back it goes, which differs by when each person came.
    const mine = video ? this.lengths.settledLength(video) : null;
    if (mine === null || this.isHoverPreview() || this.videoChange) return null;
    // What most of the others say they have. With an older server, the last state sent.
    const other = this.othersFilms
      ? differentFilm(mine, this.othersFilms)
      : this.othersFilm.duration !== null &&
          Math.abs(mine - this.othersFilm.duration) > SAME_LENGTH_SECONDS
        ? { duration: this.othersFilm.duration, source: this.othersFilm.source }
        : null;
    if (!other) return null;
    if (this.mismatchKey(mine, other.duration) === this.dismissedMismatch) return null;
    const { source } = other;
    return {
      mine,
      room: other.duration,
      host: source ? (this.openedSources.get(source) ?? null) : null,
    };
  }

  /** Looks at the address each time, so a site changing film is caught before it's touched. */
  private isOnOtherVideo(): boolean {
    this.reportPage();
    if (this.isHoverPreview()) return true;
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
      // With no video on the room's page there's no room film to still be playing: the one here
      // is just the one this tab has been on since it got here.
      this.videoChange.roomPageEmpty !== true &&
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
    if (!this.room || this.badge) return;
    if (messages) this.messages = messages;
    // The background can be slow to wake, and giving up would leave this page without a badge,
    // or a card the viewer has to act on, for as long as it's open.
    if (!messages) {
      if (this.badgeRetry === null) {
        this.badgeRetry = setTimeout(() => {
          this.badgeRetry = null;
          void this.startBadge();
        }, BADGE_RETRY_MS);
      }
      return;
    }

    this.badge = new VideoBadge({
      messages,
      position,
      onPlay: () => this.room?.engine.retryPlay(),
      onBring: () => void send({ type: "video/bring" }),
      onGo: () => void send({ type: "video/go" }),
      onLeave: () => void send({ type: "session/leave" }),
      onPause: () => this.tracker.video()?.pause(),
      onDismiss: () => {
        const notice = noticeFor(this.room?.status() ?? null);
        if (notice?.titleKey === "othersBehind") this.room?.dismissBehind();
        else {
          const shown = this.sourceMismatch();
          if (shown) this.dismissedMismatch = this.mismatchKey(shown.mine, shown.room);
        }
      },
      onPositionChange: (moved) => void saveBadgePosition(location.hostname, moved),
    });
    this.badgeTimer = setInterval(() => {
      this.checkRoomPage();
      const video = this.tracker.video();
      // A preview isn't the film, so the badge doesn't sit on it: off a film it has its own spot.
      this.badge?.update(
        this.isHoverPreview() || previewLike(video) ? null : video,
        this.room?.status() ?? null,
      );
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
    if (this.badgeRetry !== null) clearTimeout(this.badgeRetry);
    this.badgeRetry = null;
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
      case "input/seen":
        frameSession?.noteTabInput(request.at);
        return;
      case "session/status": {
        // Only one frame answers: the one running the room, or the top one if none is.
        const status = frameSession?.status() ?? null;
        if (status || (isTopFrame && !frameSession)) sendResponse(status);
        return;
      }
      case "session/bring":
        frameSession?.bringEveryone(request.sealed, request.isNewFilm);
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
