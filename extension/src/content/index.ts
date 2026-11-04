// Content script: runs the room connection and sync engine for this tab, and only
// while the tab is in a room. Pages that aren't in one get no socket and no timers.
import type { BackgroundRequest, SessionStatus, TabRequest, TabSession } from "../messages";
import { roomSocketUrl } from "../settings";
import { watchLargestVideo } from "./find-video";
import { ServerClock } from "./sync/clock";
import { RoomConnection, type CloseReason, type ConnectionStatus } from "./sync/connection";
import { SyncEngine } from "./sync/engine";

type ActiveSession = {
  code: string;
  serverUrl: string;
  status: () => SessionStatus;
  stop: () => void;
};

let active: ActiveSession | null = null;

function startSession({ code, serverUrl }: TabSession): ActiveSession {
  const clock = new ServerClock();
  let connectionStatus: ConnectionStatus = "connecting";
  let closeReason: CloseReason | null = null;
  let peers = 0;

  const engine = new SyncEngine({
    now: Date.now,
    serverNow: () => Date.now() + clock.offset,
    send: (state) => connection.sendState(state),
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

  const stopWatching = watchLargestVideo((video) => engine.bind(video));
  const onOnline = () => connection.retryNow();
  window.addEventListener("online", onOnline);
  connection.start();

  return {
    code,
    serverUrl,
    status: () => ({
      ...engine.snapshot(),
      connection: connectionStatus,
      closeReason,
      peers,
    }),
    stop: () => {
      window.removeEventListener("online", onOnline);
      stopWatching();
      connection.stop();
      engine.stop();
    },
  };
}

function applySession(session: TabSession | null): void {
  if (active && session?.code === active.code && session.serverUrl === active.serverUrl) return;
  active?.stop();
  active = session ? startSession(session) : null;
}

chrome.runtime.onMessage.addListener((request: TabRequest, _sender, sendResponse) => {
  switch (request.type) {
    case "session/changed":
      applySession(request.session);
      return;
    case "session/status":
      sendResponse(active?.status() ?? null);
      return;
  }
});

const request: BackgroundRequest = { type: "session/get" };
void chrome.runtime
  .sendMessage(request)
  .then((session: TabSession | null) => applySession(session))
  // The extension was updated or reloaded, and this script is left over from before.
  .catch(() => undefined);
