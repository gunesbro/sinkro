// Service worker: settings, which room each tab is in, and which frame of a tab runs
// the sync. It holds no connections, because it goes to sleep.
import { normalizeRoomCode } from "../../../server/src/room-code";
import { getLanguage, loadMessages } from "../i18n";
import { INVITE_ORIGIN, parseInviteFragment } from "../invite";
import type {
  BackgroundRequest,
  CreateRoomResponse,
  SessionInfo,
  TabPage,
  TabRequest,
  TabSession,
} from "../messages";
import { openRoomVideo, sealRoomVideo } from "../room-video";
import { getServerUrl } from "../settings";
import {
  broughtHere,
  describeChange,
  destination,
  NEW_TAB_VIDEO,
  pageVisited,
  roomVideoLearned,
  videoFound,
  type TabVideo,
  type VideoChange,
} from "../video-change";
import { chooseFrame, TOP_FRAME_ID, type FrameReports } from "./arbiter";

type TabFrames = { winner: number; reports: FrameReports };

// Session storage survives the worker sleeping and is cleared when the browser closes.
const tabKey = (tabId: number) => `tab:${tabId}`;
const framesKey = (tabId: number) => `frames:${tabId}`;
const videoKey = (tabId: number) => `video:${tabId}`;

async function getSession(tabId: number): Promise<TabSession | null> {
  const key = tabKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return (stored[key] as TabSession | undefined) ?? null;
}

async function getFrames(tabId: number): Promise<TabFrames> {
  const key = framesKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return (stored[key] as TabFrames | undefined) ?? { winner: TOP_FRAME_ID, reports: {} };
}

/** A tab that can't run content scripts, or is still loading, picks things up on load. */
async function sendToTab(tabId: number, request: TabRequest, frameId?: number): Promise<void> {
  const options = frameId === undefined ? {} : { frameId };
  await chrome.tabs.sendMessage(tabId, request, options).catch(() => undefined);
}

// Reports from a tab's frames arrive together, and each reads then writes its record.
const tabQueues = new Map<number, Promise<unknown>>();

function inTabQueue<T>(tabId: number, task: () => Promise<T>): Promise<T> {
  const result = (tabQueues.get(tabId) ?? Promise.resolve()).then(task, task);
  tabQueues.set(tabId, result);
  return result;
}

async function recordReport(tabId: number, frameId: number, score: number): Promise<boolean> {
  const frames = await getFrames(tabId);
  const now = Date.now();
  frames.reports[frameId] = { score, at: now };

  const winner = chooseFrame(frames.winner, frames.reports, now);
  const previous = frames.winner;
  frames.winner = winner;
  await chrome.storage.session.set({ [framesKey(tabId)]: frames });

  if (winner !== previous) {
    await sendToTab(tabId, { type: "session/role", active: false }, previous);
    await sendToTab(tabId, { type: "session/role", active: true }, winner);
  }
  return winner === frameId;
}

async function getTabVideo(tabId: number): Promise<TabVideo> {
  const key = videoKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return (stored[key] as TabVideo | undefined) ?? NEW_TAB_VIDEO;
}

/** Tells the tab's frames if this changes what the viewer should be told. Call it in the queue. */
async function updateTabVideo(
  tabId: number,
  update: (state: TabVideo) => TabVideo,
): Promise<VideoChange | null> {
  const before = await getTabVideo(tabId);
  const after = update(before);
  if (after !== before) await chrome.storage.session.set({ [videoKey(tabId)]: after });

  const change = describeChange(after);
  if (JSON.stringify(change) !== JSON.stringify(describeChange(before))) {
    await sendToTab(tabId, { type: "session/video-change", change });
  }
  return change;
}

function onPageReport(tabId: number, url: string, title: string): Promise<VideoChange | null> {
  return inTabQueue(tabId, () =>
    updateTabVideo(tabId, (state) =>
      /^https?:/.test(url) ? pageVisited(state, { url, title }) : state,
    ),
  );
}

function onRoomVideoSeen(
  tabId: number,
  sealed: string,
  announced: boolean,
): Promise<VideoChange | null> {
  return inTabQueue(tabId, async () => {
    const session = await getSession(tabId);
    const video = session && (await openRoomVideo(session.code, sealed));
    return updateTabVideo(tabId, (state) =>
      video ? roomVideoLearned(state, video, announced) : state,
    );
  });
}

function bringEveryoneHere(tabId: number): Promise<void> {
  return inTabQueue(tabId, async () => {
    const [session, { pageUrl, pageTitle }] = await Promise.all([
      getSession(tabId),
      getTabVideo(tabId),
    ]);
    if (!session) return;
    const sealed =
      pageUrl && (await sealRoomVideo(session.code, { url: pageUrl, title: pageTitle }));
    // The frame goes first: lifting the hold before it has spoken would pull this video back
    // to the old timeline, and then that's the position everyone gets brought to.
    await sendToTab(tabId, { type: "session/bring", sealed: sealed || null });
    await updateTabVideo(tabId, broughtHere);
  });
}

async function goWhereTheNoticeLeads(tabId: number): Promise<void> {
  const address = destination(await getTabVideo(tabId));
  if (address && /^https?:/.test(address)) await chrome.tabs.update(tabId, { url: address });
}

async function createRoom(): Promise<CreateRoomResponse> {
  try {
    const response = await fetch(`${await getServerUrl()}/rooms`, { method: "POST" });
    if (response.status === 429) return { error: "rate_limited" };
    if (!response.ok) return { error: "unreachable" };
    const { code } = (await response.json()) as { code: unknown };
    const normalized = typeof code === "string" ? normalizeRoomCode(code) : null;
    return normalized ? { code: normalized } : { error: "unreachable" };
  } catch {
    return { error: "unreachable" };
  }
}

async function getSessionInfo(tabId: number, frameId: number): Promise<SessionInfo> {
  const [session, frames, video] = await Promise.all([
    getSession(tabId),
    getFrames(tabId),
    getTabVideo(tabId),
  ]);
  return { session, active: frames.winner === frameId, videoChange: describeChange(video) };
}

/** Content scripts run inside web pages, so they don't get to choose a tab's room. */
function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.url?.startsWith(chrome.runtime.getURL("")) ?? false;
}

/** Puts a tab in a room, starting with the top frame until a frame reports a video. */
async function joinTab(tabId: number, code: string): Promise<TabSession> {
  const session: TabSession = { code, serverUrl: await getServerUrl() };
  await chrome.storage.session.set({ [tabKey(tabId)]: session });
  await chrome.storage.session.remove([framesKey(tabId), videoKey(tabId)]);
  return session;
}

/** Only Sinkro's own invite page may do this: any other page would be choosing a room for you. */
async function joinFromInvite(
  tabId: number,
  fragment: string,
  sender: chrome.runtime.MessageSender,
): Promise<{ joined: boolean }> {
  const refused = { joined: false };
  if (sender.frameId !== TOP_FRAME_ID || !sender.url) return refused;
  if (new URL(sender.url).origin !== INVITE_ORIGIN) return refused;

  const invite = parseInviteFragment(fragment);
  if (!invite) return refused;

  const session = await joinTab(tabId, invite.code);
  if (invite.url) {
    // The session is stored for the tab, so the page it lands on picks it up as it loads.
    await chrome.tabs.update(tabId, { url: invite.url });
  } else {
    await sendToTab(tabId, { type: "session/changed", session });
    await sendToTab(tabId, { type: "session/role", active: true }, TOP_FRAME_ID);
  }
  return { joined: true };
}

async function handleFromExtensionPage(request: BackgroundRequest) {
  switch (request.type) {
    case "room/create":
      return createRoom();
    case "session/of":
      return getSession(request.tabId);
    case "session/join": {
      const code = normalizeRoomCode(request.code);
      if (!code) return { error: "invalid_code" };
      const session = await joinTab(request.tabId, code);
      if (request.url && /^https?:/.test(request.url)) {
        // The session is stored for the tab, so the page it lands on picks it up as it loads.
        await chrome.tabs.update(request.tabId, { url: request.url });
        return { code };
      }
      await sendToTab(request.tabId, { type: "session/changed", session });
      await sendToTab(request.tabId, { type: "session/role", active: true }, TOP_FRAME_ID);
      return { code };
    }
    case "session/leave":
      await chrome.storage.session.remove([
        tabKey(request.tabId),
        framesKey(request.tabId),
        videoKey(request.tabId),
      ]);
      await sendToTab(request.tabId, { type: "session/changed", session: null });
      return null;
    case "picker/start": {
      const messages = await loadMessages(await getLanguage());
      await sendToTab(request.tabId, { type: "picker/start", messages });
      return null;
    }
    case "video/page": {
      const { pageUrl, pageTitle } = await getTabVideo(request.tabId);
      return { url: pageUrl, title: pageTitle } satisfies TabPage;
    }
    case "video/bring":
      if (request.tabId !== undefined) await bringEveryoneHere(request.tabId);
      return null;
    case "video/go":
      if (request.tabId !== undefined) await goWhereTheNoticeLeads(request.tabId);
      return null;
    default:
      return null;
  }
}

async function handle(request: BackgroundRequest, sender: chrome.runtime.MessageSender) {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? TOP_FRAME_ID;

  if (tabId !== undefined && !isExtensionPage(sender)) {
    switch (request.type) {
      case "session/get":
        return getSessionInfo(tabId, frameId);
      case "i18n/messages":
        return loadMessages(await getLanguage());
      case "invite/join":
        return joinFromInvite(tabId, request.fragment, sender);
      case "detect/report":
        return {
          active: await inTabQueue(tabId, async () => {
            if (request.score > 0) await updateTabVideo(tabId, videoFound);
            return recordReport(tabId, frameId, request.score);
          }),
        };
      case "page/report":
        return frameId === TOP_FRAME_ID ? onPageReport(tabId, request.url, request.title) : null;
      case "video/seen":
        return onRoomVideoSeen(tabId, request.sealed, request.announced);
      case "video/bring":
        await bringEveryoneHere(tabId);
        return null;
      case "video/go":
        await goWhereTheNoticeLeads(tabId);
        return null;
      case "picker/picked":
        await sendToTab(tabId, { type: "picker/stop", picked: true });
        return null;
      case "picker/cancelled":
        await sendToTab(tabId, { type: "picker/stop", picked: false });
        return null;
      default:
        return null;
    }
  }
  return isExtensionPage(sender) ? handleFromExtensionPage(request) : null;
}

chrome.runtime.onMessage.addListener((request: BackgroundRequest, sender, sendResponse) => {
  void handle(request, sender).then(sendResponse);
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabQueues.delete(tabId);
  void chrome.storage.session.remove([tabKey(tabId), framesKey(tabId), videoKey(tabId)]);
});
