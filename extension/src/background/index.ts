// Service worker: settings, which room each tab is in, and which frame of a tab runs
// the sync. It holds no connections, because it goes to sleep.
import { normalizeRoomCode } from "../../../server/src/room-code";
import { getLanguage, loadMessages } from "../i18n";
import { INVITE_ORIGIN, isSamePage, parseInviteFragment } from "../invite";
import type {
  BackgroundRequest,
  CreateRoomResponse,
  SessionInfo,
  TabPage,
  TabRequest,
  TabSession,
} from "../messages";
import { openPlayerHost, openRoomVideo, sealPlayerHost, sealRoomVideo } from "../room-video";
import { getServerUrl } from "../settings";
import {
  broughtHere,
  describeChange,
  destination,
  isOnRoomPage,
  NEW_TAB_VIDEO,
  pageVisited,
  roomVideoLearned,
  videoFound,
  type TabVideo,
  type VideoChange,
} from "../video-change";
import { chooseFrame, TOP_FRAME_ID, type FrameReports } from "./arbiter";

type TabFrames = { winner: number; reports: FrameReports };

// The accent colour and the text that goes on it.
const BADGE_BACKGROUND = "#F2B045";
const BADGE_TEXT = "#1A1208";

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

const iconSizes = (state: "on" | "off") =>
  Object.fromEntries([16, 32, 48, 128].map((size) => [size, `icons/icon-${state}-${size}.png`]));

/** Browsers forget a tab's icon when it goes to another page, so this runs again each time. */
async function showRoomOnIcon(tabId: number): Promise<void> {
  const session = await getSession(tabId);
  await chrome.action
    .setIcon({ tabId, path: iconSizes(session ? "on" : "off") })
    .catch(() => undefined);
}

async function showPeopleOnIcon(tabId: number, count: number): Promise<void> {
  const text = count > 0 ? String(count) : "";
  await chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
  await chrome.action
    .setBadgeBackgroundColor({ tabId, color: BADGE_BACKGROUND })
    .catch(() => undefined);
  await chrome.action.setBadgeTextColor?.({ tabId, color: BADGE_TEXT }).catch(() => undefined);
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
    const [session, { pageUrl, pageTitle, roomUrl }] = await Promise.all([
      getSession(tabId),
      getTabVideo(tabId),
    ]);
    if (!session) return;
    const sealed =
      pageUrl && (await sealRoomVideo(session.code, { url: pageUrl, title: pageTitle }));
    // The frame goes first: lifting the hold before it has spoken would pull this video back
    // to the old timeline, and then that's the position everyone gets brought to.
    await sendToTab(tabId, {
      type: "session/bring",
      sealed: sealed || null,
      isNewFilm: roomUrl !== null && !isSamePage(pageUrl, roomUrl),
    });
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
  await showRoomOnIcon(tabId);
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

/**
 * Browsers only add content scripts to pages that load after an install or update. Each
 * script checks whether it's already running, so a slow page can't end up with two.
 */
async function restoreScripts(tabId: number): Promise<void> {
  const target = { tabId, allFrames: true };
  try {
    await chrome.scripting.executeScript({
      target,
      files: ["page-hook.js"],
      world: "MAIN",
      injectImmediately: true,
    });
    await chrome.scripting.executeScript({ target, files: ["content.js"] });
  } catch {
    // A page extensions can't run on, like the browser's own.
  }
}

async function leaveRoom(tabId: number): Promise<void> {
  await chrome.storage.session.remove([tabKey(tabId), framesKey(tabId), videoKey(tabId)]);
  await showRoomOnIcon(tabId);
  await showPeopleOnIcon(tabId, 0);
  await sendToTab(tabId, { type: "session/changed", session: null });
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
      if (request.tabId !== undefined) await leaveRoom(request.tabId);
      return null;
    case "picker/start": {
      const messages = await loadMessages(await getLanguage());
      await sendToTab(request.tabId, { type: "picker/start", messages });
      return null;
    }
    case "scripts/restore":
      await restoreScripts(request.tabId);
      return null;
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
      case "source/seal": {
        const session = await getSession(tabId);
        return session ? sealPlayerHost(session.code, request.host) : null;
      }
      case "source/open": {
        const session = await getSession(tabId);
        return session ? openPlayerHost(session.code, request.sealed) : null;
      }
      case "video/on-room-page":
        return isOnRoomPage(await getTabVideo(tabId));
      case "room/people":
        await showPeopleOnIcon(tabId, request.count);
        return null;
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
      // The one room change a content script can ask for, because it only ever ends a room.
      case "session/leave":
        await leaveRoom(tabId);
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

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") void showRoomOnIcon(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabQueues.delete(tabId);
  void chrome.storage.session.remove([tabKey(tabId), framesKey(tabId), videoKey(tabId)]);
});
