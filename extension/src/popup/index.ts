import { formatTimecode } from "../format";
import {
  getLanguage,
  loadMessages,
  setLanguage,
  translate,
  type Language,
  type Messages,
} from "../i18n";
import { inviteLink, isSamePage, parseJoinInput } from "../invite";
import type {
  BackgroundRequest,
  CreateRoomResponse,
  JoinResponse,
  PeekReport,
  SessionStatus,
  TabRequest,
  TabSession,
} from "../messages";
import { getServerUrl, setServerUrl } from "../settings";
import { noticeFor, statusLine, type Tone } from "../status";

const STATUS_POLL_MS = 500;
const PEEK_INTERVAL_MS = 1500;
const COPIED_MS = 1500;
/** Without an answer from the tab for this long, it isn't on a page Sinkro can run on. */
const NO_PAGE_AFTER_MS = 1500;
/** Longer when the tab has just been sent to a video, which takes a moment to load. */
const NO_PAGE_AFTER_LOADING_MS = 10_000;

type View = "home" | "room" | "settings";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

let messages: Messages = {};
let tabId: number | undefined;
let session: TabSession | null = null;
let status: SessionStatus | null = null;
let view: View = "home";
/** The top frame answers even with no video, so silence means Sinkro can't run on this page. */
let pageReachable = false;
let pageTitle = "";
let pageUrl: string | null = null;
let bestPeek: { score: number; duration: number | null } = { score: 0, duration: null };
let homeError = "";
let isBusy = false;
let noAnswerSince: number | null = null;
let noPageAfterMs = NO_PAGE_AFTER_MS;

const t = (key: string, substitutions?: string[]) => translate(messages, key, substitutions);

function send<T>(request: BackgroundRequest): Promise<T> {
  return chrome.runtime.sendMessage<BackgroundRequest, T>(request);
}

function setDot(id: string, tone: Tone): void {
  element(id).dataset.tone = tone;
}

function renderStaticText(language: Language): void {
  document.documentElement.lang = language;
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n ?? "");
  }
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
    node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel ?? ""));
  }
  for (const node of document.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    node.placeholder = t(node.dataset.i18nPlaceholder ?? "");
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-lang]")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === language));
  }
}

function renderHome(): void {
  const hasVideo = bestPeek.score > 0;
  setDot("found-dot", hasVideo ? "ok" : "idle");
  element("found-text").textContent = !pageReachable
    ? t("pageUnavailable")
    : hasVideo
      ? t("found")
      : t("noVideo");
  element("video-title").textContent = hasVideo ? pageTitle : "";
  element("video-meta").textContent =
    hasVideo && bestPeek.duration !== null ? (formatTimecode(bestPeek.duration) ?? "") : "";
  element("home-error").textContent = homeError;

  element<HTMLButtonElement>("pick-home").hidden = !pageReachable;
  element<HTMLButtonElement>("create").disabled = !pageReachable || isBusy;
  // Joining works from any tab: the room is kept for the tab and starts on the next page.
  element<HTMLButtonElement>("join-form").querySelector("button")!.disabled = isBusy;
}

function renderRoom(): void {
  element("room-code").textContent = session?.code ?? "";

  const isWaitingForPage =
    !status && noAnswerSince !== null && Date.now() - noAnswerSince >= noPageAfterMs;
  const line = isWaitingForPage
    ? ({ tone: "idle", key: "waitingForVideo" } as const)
    : statusLine(status);
  setDot("room-dot", line.tone);
  element("room-status").textContent = t(line.key);

  const peers = status?.peers ?? 0;
  element("people").textContent = peers > 0 ? t("people", [String(peers)]) : "";
  element("timecode").textContent =
    status?.position !== undefined && status.position !== null
      ? (formatTimecode(status.position) ?? "")
      : "";

  const notice = isWaitingForPage
    ? ({
        tone: "idle",
        titleKey: "openVideoHere",
        bodyKey: "openVideoHereHelp",
        action: null,
      } as const)
    : noticeFor(status);
  element("alert").hidden = !notice;
  if (notice) {
    setDot("alert-dot", notice.tone);
    element("alert-title").textContent = t(notice.titleKey);
    element("alert-body").textContent = t(notice.bodyKey);
    element("pick-room").hidden = notice.action !== "pick";
  }
  element<HTMLButtonElement>("move-badge").disabled = !status?.hasVideo;
  element<HTMLButtonElement>("bring").disabled =
    status?.connection !== "connected" || !status.hasVideo || status.hold !== null;
}

function render(): void {
  element("home").hidden = view !== "home";
  element("room").hidden = view !== "room";
  element("settings").hidden = view !== "settings";
  if (view === "home") renderHome();
  if (view === "room") renderRoom();
}

function setView(next: View): void {
  view = next;
  render();
}

async function refreshLanguage(language: Language): Promise<void> {
  messages = await loadMessages(language);
  renderStaticText(language);
  render();
}

async function refreshStatus(): Promise<void> {
  if (tabId === undefined || !session) return;
  const request: TabRequest = { type: "session/status" };
  status =
    (await chrome.tabs
      .sendMessage<TabRequest, SessionStatus | null>(tabId, request)
      .catch(() => null)) ?? null;
  if (status) noAnswerSince = null;
  else noAnswerSince ??= Date.now();
  if (view === "room") renderRoom();
}

function peek(): void {
  if (tabId === undefined) return;
  const request: TabRequest = { type: "detect/peek" };
  void chrome.tabs.sendMessage(tabId, request).catch(() => undefined);
}

/** Frames answer one by one, and only some have a video, so the highest score so far wins. */
function onPeekReport(report: PeekReport): void {
  pageReachable = true;
  if (report.title !== null) pageTitle = report.title;
  if (report.url !== null) pageUrl = report.url;
  if (report.score >= bestPeek.score) {
    bestPeek = { score: report.score, duration: report.duration };
  }
  if (view === "home") renderHome();
}

async function enterRoom(code: string, url?: string): Promise<void> {
  if (tabId === undefined) return;
  const joined = await send<JoinResponse>({ type: "session/join", tabId, code, url });
  if ("error" in joined) {
    homeError = t("badCode");
    render();
    return;
  }
  session = await send<TabSession | null>({ type: "session/of", tabId });
  status = null;
  noAnswerSince = null;
  noPageAfterMs = url ? NO_PAGE_AFTER_LOADING_MS : NO_PAGE_AFTER_MS;
  homeError = "";
  setView("room");
  void refreshStatus();
}

async function onCreate(): Promise<void> {
  isBusy = true;
  homeError = "";
  render();
  const created = await send<CreateRoomResponse>({ type: "room/create" });
  isBusy = false;
  if ("error" in created) {
    homeError = t(created.error === "rate_limited" ? "tooManyRooms" : "cantReach");
    render();
    return;
  }
  await enterRoom(created.code);
}

async function onJoin(event: Event): Promise<void> {
  event.preventDefault();
  const input = element<HTMLInputElement>("join-input");
  const parsed = parseJoinInput(input.value);
  if (!parsed) {
    homeError = t("badCode");
    render();
    input.focus();
    return;
  }
  // A link's video opens here, unless this tab is already on it.
  await enterRoom(
    parsed.code,
    parsed.url && !isSamePage(pageUrl, parsed.url) ? parsed.url : undefined,
  );
}

async function onLeave(): Promise<void> {
  if (tabId === undefined) return;
  await send({ type: "session/leave", tabId });
  session = null;
  status = null;
  setView("home");
}

async function startPicker(): Promise<void> {
  if (tabId === undefined) return;
  await send({ type: "picker/start", tabId });
  // Picking happens on the page, and a click there would close the popup anyway.
  window.close();
}

/** Says "Copied" on the button itself, then puts its label back. */
async function copyWithFeedback(button: HTMLElement, text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  const isIconButton = button.classList.contains("icon-button");
  const original = isIconButton ? button.getAttribute("aria-label") : button.textContent;
  if (isIconButton) button.setAttribute("aria-label", t("copied"));
  else button.textContent = t("copied");
  element("room-status").textContent = t("copied");
  setTimeout(() => {
    if (isIconButton) button.setAttribute("aria-label", original ?? "");
    else button.textContent = original;
    render();
  }, COPIED_MS);
}

async function openSettings(): Promise<void> {
  element<HTMLInputElement>("server-input").value = await getServerUrl();
  element("server-error").textContent = "";
  setView("settings");
  element("server-input").focus();
}

function closeSettings(): void {
  setView(session ? "room" : "home");
  element("open-settings").focus();
}

async function onSaveSettings(event: Event): Promise<void> {
  event.preventDefault();
  const saved = await setServerUrl(element<HTMLInputElement>("server-input").value);
  if (!saved) {
    element("server-error").textContent = t("serverInvalid");
    return;
  }
  closeSettings();
}

function connectEvents(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-lang]")) {
    button.addEventListener("click", async () => {
      const language = button.dataset.lang as Language;
      await setLanguage(language);
      await refreshLanguage(language);
    });
  }
  element("create").addEventListener("click", () => void onCreate());
  element("join-form").addEventListener("submit", (event) => void onJoin(event));
  element("leave").addEventListener("click", () => void onLeave());
  element("pick-home").addEventListener("click", () => void startPicker());
  element("pick-room").addEventListener("click", () => void startPicker());
  element("bring").addEventListener("click", () => {
    if (tabId === undefined) return;
    const request: TabRequest = { type: "session/bring" };
    void chrome.tabs.sendMessage(tabId, request).catch(() => undefined);
  });
  element("move-badge").addEventListener("click", () => {
    if (tabId === undefined) return;
    const request: TabRequest = { type: "badge/move" };
    void chrome.tabs.sendMessage(tabId, request).catch(() => undefined);
    // The moving happens on the page, and a click there would close the popup anyway.
    window.close();
  });
  element("copy-code").addEventListener("click", (event) => {
    if (session) void copyWithFeedback(event.currentTarget as HTMLElement, session.code);
  });
  element("copy-link").addEventListener("click", (event) => {
    if (session) {
      void copyWithFeedback(event.currentTarget as HTMLElement, inviteLink(session.code, pageUrl));
    }
  });
  element("open-settings").addEventListener("click", () => void openSettings());
  element("close-settings").addEventListener("click", closeSettings);
  element("settings-form").addEventListener("submit", (event) => void onSaveSettings(event));
  chrome.runtime.onMessage.addListener((message: BackgroundRequest) => {
    if (message.type === "detect/peeked") onPeekReport(message.report);
  });
}

async function start(): Promise<void> {
  connectEvents();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;

  await refreshLanguage(await getLanguage());
  if (tabId !== undefined) session = await send<TabSession | null>({ type: "session/of", tabId });
  setView(session ? "room" : "home");

  // The first look also finds the page address for invite links. After that, keep looking
  // only on the home view, where a video that's still loading can turn up.
  peek();
  setInterval(() => {
    // In a room, keep looking only until the address for invite links turns up.
    if (view === "home" || !pageUrl) peek();
  }, PEEK_INTERVAL_MS);
  void refreshStatus();
  setInterval(() => void refreshStatus(), STATUS_POLL_MS);
}

void start();
