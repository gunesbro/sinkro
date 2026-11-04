// Service worker: settings, which room each tab is in, and which frame of a tab runs
// the sync. It holds no connections, because it goes to sleep.
import { normalizeRoomCode } from "../../../server/src/room-code";
import { getLanguage, loadMessages } from "../i18n";
import type {
  BackgroundRequest,
  CreateRoomResponse,
  SessionInfo,
  TabRequest,
  TabSession,
} from "../messages";
import { getServerUrl } from "../settings";
import { chooseFrame, TOP_FRAME_ID, type FrameReports } from "./arbiter";

type TabFrames = { winner: number; reports: FrameReports };

// Session storage survives the worker sleeping and is cleared when the browser closes.
const tabKey = (tabId: number) => `tab:${tabId}`;
const framesKey = (tabId: number) => `frames:${tabId}`;

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
  const [session, frames] = await Promise.all([getSession(tabId), getFrames(tabId)]);
  return { session, active: frames.winner === frameId };
}

/** Content scripts run inside web pages, so they don't get to choose a tab's room. */
function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.url?.startsWith(chrome.runtime.getURL("")) ?? false;
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
      const session: TabSession = { code, serverUrl: await getServerUrl() };
      await chrome.storage.session.set({ [tabKey(request.tabId)]: session });
      await chrome.storage.session.remove(framesKey(request.tabId));
      await sendToTab(request.tabId, { type: "session/changed", session });
      await sendToTab(request.tabId, { type: "session/role", active: true }, TOP_FRAME_ID);
      return { code };
    }
    case "session/leave":
      await chrome.storage.session.remove([tabKey(request.tabId), framesKey(request.tabId)]);
      await sendToTab(request.tabId, { type: "session/changed", session: null });
      return null;
    case "picker/start": {
      const messages = await loadMessages(await getLanguage());
      await sendToTab(request.tabId, { type: "picker/start", messages });
      return null;
    }
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
      case "detect/report":
        return {
          active: await inTabQueue(tabId, () => recordReport(tabId, frameId, request.score)),
        };
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
  void chrome.storage.session.remove([tabKey(tabId), framesKey(tabId)]);
});
