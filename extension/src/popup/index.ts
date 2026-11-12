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
  TabPage,
  TabRequest,
  TabSession,
} from "../messages";
import { nameText, namesInRoom, pickAnotherName } from "../names";
import { openRoomVideo, sealRoomVideo } from "../room-video";
import {
  getCustomServerUrl,
  getShowReactions,
  roomSocketUrl,
  setServerUrl,
  setShowReactions,
} from "../settings";
import {
  isVideoChangeAction,
  noticeFor,
  statusLine,
  withoutSiteName,
  type Notice,
  type Tone,
} from "../status";
import { askRoomVideo } from "./room-link";

const STATUS_POLL_MS = 500;
const PEEK_INTERVAL_MS = 1500;
const COPIED_MS = 1500;
/** Past this with no answer, the tab probably has no script running. */
const RESTORE_AFTER_MS = 400;
/** Someone can change the room's video with "Bring everyone to me" while this is open. */
const ROOM_VIDEO_POLL_MS = 5000;
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
let roomVideoUrl: string | null = null;
let roomVideoTitle = "";
let isRoomGone = false;

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

let shownPeople = "";

/** Yours first, then the others in the order they came. Redrawn only when someone changes. */
function renderPeople(): void {
  const list = status?.connection === "connected" ? (status.people ?? []) : [];
  const shown = namesInRoom(list.map(({ pick }) => (pick ? nameText(pick, messages) : null)));
  const lines = list
    .map(({ isYou }, index) => {
      const name = shown[index] ?? t("personUnnamed");
      return { isYou, text: isYou ? t("peopleYou", [name]) : name };
    })
    .sort((a, b) => Number(b.isYou) - Number(a.isYou));
  const key = JSON.stringify(lines);
  if (key === shownPeople) return;
  shownPeople = key;
  element("people-section").hidden = lines.length === 0;
  element("people-list").replaceChildren(
    ...lines.map(({ text }) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }),
  );
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
  const people = peers > 0 ? t("people", [String(peers)]) : "";
  // Hundredths are what anyone can make sense of, in the way this language writes them.
  const spread =
    status?.spread !== null && status?.spread !== undefined
      ? t("spreadWithin", [
          status.spread.toLocaleString(document.documentElement.lang || "en", {
            maximumFractionDigits: 2,
          }),
        ])
      : "";
  element("people").textContent = people;
  element("spread").textContent = spread;
  renderPeople();
  element("timecode").textContent = status?.isLive
    ? t("liveTime")
    : status?.position !== undefined && status.position !== null
      ? (formatTimecode(status.position) ?? "")
      : "";

  const change = status?.videoChange ?? null;
  const changeNotice = change ? noticeFor(status) : null;
  // With no video on the room's page there's nothing to go back to: bringing everyone is it.
  const canFollowChange = isVideoChangeAction(changeNotice) && changeNotice?.noWayBack !== true;
  const isFilmStillPlaying = status?.isFilmStillPlaying === true;
  const canGoToVideo =
    !change && !isFilmStillPlaying && roomVideoUrl !== null && !isSamePage(pageUrl, roomVideoUrl);
  const showGoButton = (canFollowChange || canGoToVideo) && !isRoomGone;
  element("go-video").hidden = !showGoButton;
  // There's nothing to invite anyone to in a room that's closed.
  element("copy-link").hidden = isRoomGone || status?.connection === "closed";
  if (showGoButton) {
    const host = change ? change.host : new URL(roomVideoUrl ?? "").hostname;
    element("go-video").textContent =
      change?.kind === "you_moved" ? t("backToRoom") : t("goToVideo", [host]);
  }
  // One main action per view: here it's getting to the video, not sharing the room.
  // Or bringing everyone, when that's what's asked: then sharing waits until it's done.
  const isSharingMain = !showGoButton && changeNotice?.action !== "bring";
  element("copy-link").classList.toggle("primary", isSharingMain);
  element("copy-link").classList.toggle("secondary", !isSharingMain);
  // Unless they've wandered off with a video to bring everyone to.
  const isBringMain = changeNotice?.action === "bring";
  element("go-video").classList.toggle("primary", !isBringMain);
  element("go-video").classList.toggle("secondary", isBringMain);
  element("bring").classList.toggle("primary", isBringMain);
  element("bring").classList.toggle("secondary", !isBringMain);

  const goneNotice: Notice = {
    tone: "danger",
    titleKey: "roomGone",
    bodyKey: "roomGoneHelp",
    action: null,
  };
  const waitingNotice: Notice = {
    tone: "idle",
    titleKey: "openVideoHere",
    bodyKey: "openVideoHereHelp",
    action: null,
  };
  // Says outright that nothing has opened, so nobody sits waiting for the video to appear.
  const goNotice: Notice = {
    tone: "warn",
    titleKey: "inRoomGo",
    bodyKey: "inRoomGoHelp",
    action: null,
    detail: roomVideoUrl
      ? withoutSiteName(roomVideoTitle, new URL(roomVideoUrl).hostname)
      : roomVideoTitle,
  };
  // The tab knows why the room closed, which the popup's own look at the server can't say.
  const notice =
    isRoomGone && status?.closeReason !== "room_idle"
      ? goneNotice
      : (changeNotice ??
        (showGoButton ? goNotice : isWaitingForPage ? waitingNotice : noticeFor(status)));
  // Says why bringing everyone is off, in the popup only: on the page it would cover the film.
  const floatingNotice: Notice = {
    tone: "idle",
    titleKey: "floatingPlayer",
    bodyKey: "floatingPlayerHelp",
    action: null,
  };
  // Says what "live" means for the room, in the popup only, so it never sits over the stream.
  const liveNotice: Notice = {
    tone: "idle",
    titleKey: "liveNotice",
    bodyKey: "liveNoticeHelp",
    action: null,
  };
  const shownNotice =
    notice ?? (status?.isFloatingPlayer ? floatingNotice : status?.isLive ? liveNotice : null);
  element("alert").hidden = !shownNotice;
  if (shownNotice) {
    setDot("alert-dot", shownNotice.tone);
    element("alert-title").textContent = t(shownNotice.titleKey, shownNotice.titleSubstitutions);
    element("alert-detail").textContent = shownNotice.detail ?? "";
    element("alert-body").textContent = t(shownNotice.bodyKey, shownNotice.bodySubstitutions);
    element("pick-room").hidden = shownNotice.action !== "pick";
  }
  element<HTMLButtonElement>("move-badge").disabled = !status?.hasVideo;
  // Being on another video is exactly when this button is the way out.
  const isHeldBack = status?.hold != null && status.hold !== "other_video";
  // The page's address isn't the film's here, and that's what bringing everyone would send.
  element<HTMLButtonElement>("bring").disabled =
    status?.connection !== "connected" || !status.hasVideo || isHeldBack || status.isFloatingPlayer;
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
  // Sites change address without loading a page, and the tab reports it to the background.
  const page = await send<TabPage>({ type: "video/page", tabId }).catch(() => null);
  if (page?.url) {
    pageUrl = page.url;
    pageTitle = page.title;
  }
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

async function refreshRoomVideo(): Promise<void> {
  if (!session || view !== "room") return;
  const { code, serverUrl } = session;
  const answer = await askRoomVideo(roomSocketUrl(serverUrl, code), { type: "video/get" });
  if (session?.code !== code) return;

  if (answer.status === "gone") isRoomGone = true;
  if (answer.status === "ok") {
    isRoomGone = false;
    const video = answer.sealed ? await openRoomVideo(code, answer.sealed) : null;
    roomVideoUrl = video?.url ?? null;
    roomVideoTitle = video?.title ?? "";
  }
  if (view === "room") renderRoom();
}

/** Only on purpose, when creating a room. Moving it later goes through the tab's connection. */
async function shareThisVideo(): Promise<void> {
  if (!session || !pageUrl) return;
  const { code, serverUrl } = session;
  const sealed = await sealRoomVideo(code, { url: pageUrl, title: pageTitle });
  if (!sealed) return;
  const answer = await askRoomVideo(roomSocketUrl(serverUrl, code), { type: "video/set", sealed });
  if (answer.status === "ok") {
    roomVideoUrl = pageUrl;
    roomVideoTitle = pageTitle;
  }
  if (view === "room") renderRoom();
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
  roomVideoUrl = null;
  roomVideoTitle = "";
  isRoomGone = false;
  homeError = "";
  setView("room");
  void refreshStatus();
  void refreshRoomVideo();
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
  await shareThisVideo();
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
  roomVideoUrl = null;
  roomVideoTitle = "";
  isRoomGone = false;
  status = null;
  setView("home");
}

async function startPicker(): Promise<void> {
  if (tabId === undefined) return;
  await send({ type: "picker/start", tabId });
  // Picking happens on the page, and a click there would close the popup anyway.
  window.close();
}

/** Buttons saying "Copied" for now, with the label each goes back to. */
const copiedButtons = new Map<HTMLElement, { label: string | null; timer: number }>();

/** Says "Copied" on the button itself, then puts its label back. */
async function copyWithFeedback(button: HTMLElement, text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  const isIconButton = button.classList.contains("icon-button");
  // Pressed again while it says "Copied": what's on it now isn't its label.
  const showing = copiedButtons.get(button);
  if (showing) clearTimeout(showing.timer);
  const label =
    showing?.label ?? (isIconButton ? button.getAttribute("aria-label") : button.textContent);
  if (isIconButton) button.setAttribute("aria-label", t("copied"));
  else button.textContent = t("copied");
  element("room-status").textContent = t("copied");
  const timer = window.setTimeout(() => {
    copiedButtons.delete(button);
    if (isIconButton) button.setAttribute("aria-label", label ?? "");
    else button.textContent = label;
    render();
  }, COPIED_MS);
  copiedButtons.set(button, { label, timer });
}

async function openSettings(): Promise<void> {
  // Sinkro's own server isn't spelled out: the field stays empty, and its placeholder says so.
  element<HTMLInputElement>("server-input").value = (await getCustomServerUrl()) ?? "";
  element("server-error").textContent = "";
  // People compare this when something only happens for one of them.
  element("version").textContent = `Sinkro ${chrome.runtime.getManifest().version}`;
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
  element("pick-any").addEventListener("click", () => void startPicker());
  element("go-video").addEventListener("click", () => {
    if (tabId === undefined) return;
    noAnswerSince = null;
    noPageAfterMs = NO_PAGE_AFTER_LOADING_MS;
    if (status?.videoChange) {
      void send({ type: "video/go", tabId });
      return;
    }
    if (!roomVideoUrl) return;
    pageUrl = roomVideoUrl;
    void chrome.tabs.update(tabId, { url: roomVideoUrl });
    render();
  });
  element("bring").addEventListener("click", () => {
    if (tabId === undefined) return;
    void send({ type: "video/bring", tabId });
    if (pageUrl) {
      roomVideoUrl = pageUrl;
      roomVideoTitle = pageTitle;
    }
    const button = element("bring");
    button.textContent = t("bringSent");
    setTimeout(() => {
      button.textContent = t("bring");
    }, COPIED_MS);
  });
  element("new-name").addEventListener("click", () => {
    // The tab passes it to the room, and the next look at its status shows the new one.
    void pickAnotherName();
  });
  const showReactions = element<HTMLInputElement>("show-reactions");
  void getShowReactions().then((show) => {
    showReactions.checked = show;
  });
  // The tabs hear it from storage, so the video changes as the switch does.
  showReactions.addEventListener("change", () => void setShowReactions(showReactions.checked));
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
      // The room's video first: whoever copies this may not be on that page themselves.
      const link = inviteLink(session.code, roomVideoUrl ?? pageUrl);
      void copyWithFeedback(event.currentTarget as HTMLElement, link);
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
  setTimeout(() => {
    if (pageReachable || tabId === undefined) return;
    void send({ type: "scripts/restore", tabId }).then(() => {
      peek();
      void refreshStatus();
    });
  }, RESTORE_AFTER_MS);
  setInterval(() => {
    // In a room, keep looking only until the address for invite links turns up.
    if (view === "home" || !pageUrl) peek();
  }, PEEK_INTERVAL_MS);
  void refreshStatus();
  setInterval(() => void refreshStatus(), STATUS_POLL_MS);
  void refreshRoomVideo();
  setInterval(() => void refreshRoomVideo(), ROOM_VIDEO_POLL_MS);
}

void start();
