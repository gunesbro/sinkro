// Service worker: settings and which room each tab is in. It holds no connections,
// because it goes to sleep. Frame coordination arrives with the detection PR.
import { normalizeRoomCode } from "../../../server/src/room-code";
import type { BackgroundRequest, CreateRoomResponse, TabRequest, TabSession } from "../messages";
import { getServerUrl } from "../settings";

// Session storage survives the worker sleeping and is cleared when the browser closes.
const tabKey = (tabId: number) => `tab:${tabId}`;

async function getSession(tabId: number): Promise<TabSession | null> {
  const key = tabKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return (stored[key] as TabSession | undefined) ?? null;
}

async function notifyTab(tabId: number, session: TabSession | null): Promise<void> {
  const request: TabRequest = { type: "session/changed", session };
  // A tab that can't run content scripts, or is still loading, picks it up on load.
  await chrome.tabs.sendMessage(tabId, request).catch(() => undefined);
}

async function createRoom(): Promise<CreateRoomResponse> {
  try {
    const response = await fetch(`${await getServerUrl()}/rooms`, { method: "POST" });
    if (!response.ok) return { error: "unreachable" };
    const { code } = (await response.json()) as { code: unknown };
    const normalized = typeof code === "string" ? normalizeRoomCode(code) : null;
    return normalized ? { code: normalized } : { error: "unreachable" };
  } catch {
    return { error: "unreachable" };
  }
}

/** Content scripts run inside web pages, so they don't get to choose a tab's room. */
function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.url?.startsWith(chrome.runtime.getURL("")) ?? false;
}

async function handle(request: BackgroundRequest, sender: chrome.runtime.MessageSender) {
  if (request.type === "session/get") {
    return sender.tab?.id === undefined ? null : getSession(sender.tab.id);
  }
  if (!isExtensionPage(sender)) return null;

  switch (request.type) {
    case "room/create":
      return createRoom();
    case "session/join": {
      const code = normalizeRoomCode(request.code);
      if (!code) return { error: "invalid_code" };
      const session: TabSession = { code, serverUrl: await getServerUrl() };
      await chrome.storage.session.set({ [tabKey(request.tabId)]: session });
      await notifyTab(request.tabId, session);
      return { code };
    }
    case "session/leave":
      await chrome.storage.session.remove(tabKey(request.tabId));
      await notifyTab(request.tabId, null);
      return null;
  }
}

chrome.runtime.onMessage.addListener((request: BackgroundRequest, sender, sendResponse) => {
  void handle(request, sender).then(sendResponse);
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(tabKey(tabId));
});
