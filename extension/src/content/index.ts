// Content script, in every frame. While the tab is in a room, each frame looks for
// videos and reports its best one, and the background picks one frame to run the room
// connection and sync engine. Pages that aren't in a room get no socket and no timers.
import type {
  BackgroundRequest,
  PeekReport,
  ReportResponse,
  SessionInfo,
  SessionStatus,
  TabRequest,
  TabSession,
} from "../messages";
import { INVITE_ORIGIN } from "../invite";
import { roomSocketUrl } from "../settings";
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
import { SyncEngine } from "./sync/engine";

const isTopFrame = window === window.top;

type Room = {
  engine: SyncEngine;
  status: () => SessionStatus;
  stop: () => void;
};

function startRoom({ code, serverUrl }: TabSession, tracker: VideoTracker): Room {
  const clock = new ServerClock();
  let connectionStatus: ConnectionStatus = "connecting";
  let closeReason: CloseReason | null = null;
  let peers = 0;

  const engine = new SyncEngine({
    now: Date.now,
    serverNow: () => Date.now() + clock.offset,
    send: (state) => connection.sendState(state),
    holdFor: (roomPosition) => tracker.holdReason(roomPosition),
  });
  const connection = new RoomConnection({
    url: roomSocketUrl(serverUrl, code),
    clock,
    events: {
      onJoined: (message) => {
        peers = message.peers;
        engine.handleJoined(message);
      },
      onState: (state) => engine.handleState(state),
      onPeers: (count) => {
        peers = count;
      },
      onRejected: () => engine.handleRejected(),
      onDisconnected: () => engine.handleDisconnected(),
      onStatus: (status, reason) => {
        connectionStatus = status;
        closeReason = reason;
      },
    },
  });

  engine.bind(tracker.video());
  const onOnline = () => connection.retryNow();
  window.addEventListener("online", onOnline);
  connection.start();

  return {
    engine,
    status: () => ({
      ...engine.snapshot(),
      connection: connectionStatus,
      closeReason,
      peers,
    }),
    stop: () => {
      window.removeEventListener("online", onOnline);
      connection.stop();
      engine.stop();
    },
  };
}

function send<T>(request: BackgroundRequest): Promise<T | undefined> {
  // A rejection means the extension was updated and this script is left over from before.
  return chrome.runtime.sendMessage<BackgroundRequest, T>(request).catch(() => undefined);
}

/** This frame's part in a room: always looking for videos, sometimes running the sync. */
class FrameSession {
  readonly tracker: VideoTracker;
  private room: Room | null = null;
  private isStopped = false;
  private readonly onPageHide = () => this.report(0);

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
    void loadRemembered(location.hostname)
      .catch(() => null)
      .then((selector) => {
        if (!this.isStopped) this.tracker.start(selector);
      });
  }

  setActive(active: boolean): void {
    if (active && !this.room) {
      this.room = startRoom(this.session, this.tracker);
    } else if (!active && this.room) {
      this.room.stop();
      this.room = null;
    }
  }

  status(): SessionStatus | null {
    return this.room?.status() ?? null;
  }

  bringEveryone(): void {
    this.room?.engine.bringEveryone();
  }

  stop(): void {
    this.isStopped = true;
    window.removeEventListener("pagehide", this.onPageHide);
    this.setActive(false);
    this.tracker.stop();
  }

  private report(score: number): void {
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
      frameSession?.bringEveryone();
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

void send<SessionInfo>({ type: "session/get" }).then((info) => {
  if (!info) return;
  applySession(info.session);
  frameSession?.setActive(info.active);
});
