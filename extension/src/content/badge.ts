import type { ReactionId } from "../../../server/src/protocol";
import { translate, type Messages } from "../i18n";
import type { SessionStatus } from "../messages";
import { parentAcrossShadow } from "./detection/floating";
import {
  hasMainButton,
  isVideoChangeAction,
  mustShowNotice,
  noticeFor,
  statusLine,
  type Notice,
  type Tone,
} from "../status";
import {
  CHIP_AT_REST,
  isSpotOnScreen,
  isVideoOnScreen,
  nudge,
  placeBadge,
  positionAt,
  spotOf,
  type BadgePosition,
  type Box,
} from "./badge-position";
import { COOLDOWN_MS, REACTION_EMOJI, admit, canSend, type Floater } from "../reactions";
import { markOwnElement } from "./detection/discovery";
import { ReactionsLayer } from "./reactions-layer";
import {
  ACCENT,
  BUTTON_BORDER,
  DANGER,
  FAINT,
  FONT,
  MUTED,
  OK,
  ON_ACCENT,
  OVERLAY_BACKGROUND,
  OVERLAY_BACKGROUND_QUIET,
  OVERLAY_BORDER,
  TEXT,
  TEXT_SECONDARY,
  TOP_LAYER,
} from "./theme";

/** On anything smaller, the badge would cover what it's reporting on. */
const MIN_VIDEO_WIDTH_PX = 240;
const MIN_VIDEO_HEIGHT_PX = 120;
/** All's well for this long, and the badge shrinks to its dot so the film has the screen. */
const QUIET_AFTER_MS = 5000;
/** How long "Starting…" stays before offering the button again, if nothing has happened. */
const JOIN_PRESS_MS = 5000;
/** Long enough to read in passing, and it asks nothing of anyone. */
const FLASH_MS = 3000;
/** Space to leave under something the site has pinned along the top. */
const BELOW_BAR_PX = 8;
/** Where to look for that, near the top of the window. */
const TOP_OF_WINDOW_PX = 28;
/** Anything covering more of the video than this is an overlay of some kind, not a bar. */
const MAX_BAR_SHARE_OF_VIDEO = 0.5;
/** Taller than this share of the window, and it's a layer over the page, not its bar. */
const MAX_BAR_SHARE_OF_WINDOW_HEIGHT = 0.25;
/** Every card the same width, so its buttons line up whatever they say. */
const CARD_WIDTH_PX = 288;
/** The widest the pill and card together get. */
const STACK_MAX_WIDTH_PX = 300;
/** Long enough for the pointer to cross from the chip to the reactions under it. */
const HOVER_GAP_MS = 300;
/** Whose reaction it is, for the viewer's own. No id from a room looks like this. */
const OWN_REACTION = "own";
const REACTION_LABELS: Record<ReactionId, string> = {
  laugh: "reactLaugh",
  heart: "reactHeart",
  wow: "reactWow",
  sad: "reactSad",
  clap: "reactClap",
  fire: "reactFire",
};
/** A pointer on the badge must never reach the player underneath. */
const SWALLOWED_EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"];

const TONE_COLORS: Record<Tone, string> = {
  ok: OK,
  warn: ACCENT,
  danger: DANGER,
  idle: FAINT,
};

export type BadgeOptions = {
  messages: Messages;
  position: BadgePosition | null;
  onPlay: () => void;
  onBring: () => void;
  onGo: () => void;
  onLeave: () => void;
  onPause: () => void;
  onDismiss: () => void;
  onPositionChange: (position: BadgePosition | null) => void;
  /** The viewer pressed a reaction. It's already on their own screen. */
  onReact: (id: ReactionId) => void;
};

function containsAcrossShadow(outer: Element, inner: Element): boolean {
  for (let node: Element | null = inner; node; node = parentAcrossShadow(node)) {
    if (node === outer) return true;
  }
  return false;
}

/**
 * Something the site has pinned over this point, like a bar across the top. An overlay of
 * the player's own doesn't count, and neither does one covering most of the video: a
 * dialog's backdrop, or the invisible sheets some sites use to catch clicks.
 */
function siteBarAt(
  x: number,
  y: number,
  own: Element,
  video: HTMLVideoElement | null,
): DOMRect | null {
  const top = document.elementsFromPoint(x, y).find((element) => element !== own);
  if (!top || (video && containsAcrossShadow(top, video))) return null;

  for (let node: Element | null = top; node; node = parentAcrossShadow(node)) {
    const { position } = getComputedStyle(node);
    if (position !== "fixed" && position !== "sticky") continue;
    if (video && containsAcrossShadow(node, video)) return null;

    const box = node.getBoundingClientRect();
    // A site's bar is short. Something taller, like a cookie or sign-in layer dimming the whole
    // page, would push the badge below it, off the window.
    if (box.height > window.innerHeight * MAX_BAR_SHARE_OF_WINDOW_HEIGHT) return null;
    const videoBox = video?.getBoundingClientRect();
    const limit = videoBox
      ? videoBox.width * videoBox.height * MAX_BAR_SHARE_OF_VIDEO
      : Number.POSITIVE_INFINITY;
    return box.width * box.height < limit ? box : null;
  }
  return null;
}

/**
 * Always-visible sync status over the video, with a card for anything that needs the
 * viewer. At rest it's a dot and a count, and it opens under the pointer so it can be
 * dragged somewhere else. It takes clicks only on itself, which is why it stays this small.
 * Styled through the CSSOM because a page's CSP can block style elements.
 */
export class VideoBadge {
  private readonly host = document.createElement("div");
  private readonly stack = document.createElement("div");
  private readonly pill = document.createElement("div");
  private readonly grip = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  private readonly dot = document.createElement("span");
  private readonly pillText = document.createElement("span");
  private readonly pillCount = document.createElement("span");
  private readonly pillHint = document.createElement("span");
  private readonly flashMessage = document.createElement("div");
  private readonly card = document.createElement("div");
  private readonly cardDot = document.createElement("span");
  private readonly cardTitle = document.createElement("span");
  private readonly cardDetail = document.createElement("span");
  private readonly cardHost = document.createElement("span");
  private readonly secondaryActions = document.createElement("div");
  private readonly cardBody = document.createElement("span");
  private readonly action = document.createElement("button");
  private readonly returnAction: HTMLElement;
  private readonly bringAction: HTMLElement;
  private readonly leaveAction: HTMLElement;
  private readonly movePanel = document.createElement("div");
  private readonly reactionRow = document.createElement("div");
  private readonly reactionButtons: HTMLButtonElement[] = [];
  private readonly layer: ReactionsLayer;
  private readonly onReact: (id: ReactionId) => void;
  /** Whether there's anyone to send a reaction to, and the viewer wants them at all. */
  private reactionsShown = false;
  private lastReactionAt: number | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private onScreen: Floater[] = [];
  private readonly listeners = new AbortController();
  private readonly messages: Messages;
  private readonly onPositionChange: (position: BadgePosition | null) => void;
  private video: HTMLVideoElement | null = null;
  private status: SessionStatus | null = null;
  private frameRequest: number | null = null;
  private position: BadgePosition | null;
  private positionBeforeMove: BadgePosition | null = null;
  private isMoving = false;
  private isHovering = false;
  private dragOffset: { x: number; y: number } | null = null;
  private dragPointerId: number | null = null;
  private hasDragged = false;
  private positionBeforeDrag: BadgePosition | null = null;
  private lastChangeAt = 0;
  private lastPillText = "";
  private lastPillLabel = "";
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private joinPressedAt = Number.NEGATIVE_INFINITY;
  private actionShown: Notice["action"] = null;

  constructor(options: BadgeOptions) {
    this.messages = options.messages;
    this.position = options.position;
    this.onPositionChange = options.onPositionChange;
    this.onReact = options.onReact;

    markOwnElement(this.host);
    this.host.style.cssText = `all: initial; position: fixed; inset: 0; z-index: ${TOP_LAYER};
      pointer-events: none;`;
    const root = this.host.attachShadow({ mode: "closed" });
    this.returnAction = this.createPanelButton("backToRoom", false, options.onGo);
    this.bringAction = this.createPanelButton("bring", false, options.onBring);
    this.leaveAction = this.createPanelButton("leave", false, options.onLeave);
    // Lighter than the choices beside it, since it's a way out rather than one of them.
    this.leaveAction.style.color = DANGER;
    this.leaveAction.style.boxShadow = "none";
    this.leaveAction.style.padding = "12px 10px";
    this.leaveAction.style.flex = "none";
    this.returnAction.style.flex = "1";
    this.bringAction.style.flex = "1";
    this.buildContent(root);
    this.layer = new ReactionsLayer(root);

    this.action.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.actionShown === "bring") {
        options.onBring();
      } else if (this.actionShown === "go" || this.actionShown === "return") {
        options.onGo();
      } else if (this.actionShown === "pause") {
        options.onPause();
      } else if (this.actionShown === "dismiss") {
        options.onDismiss();
      } else {
        // Answer the click at once: playback can take a moment to start.
        this.joinPressedAt = Date.now();
        options.onPlay();
        this.update(this.video, this.status);
      }
    });
    this.connectMoving();
    document.addEventListener("fullscreenchange", () => this.attach(), {
      signal: this.listeners.signal,
    });
    // The regular update is too slow for this, and the badge would trail behind its video.
    const followNextFrame = () => this.followNextFrame();
    const passive = { capture: true, passive: true, signal: this.listeners.signal };
    window.addEventListener("scroll", followNextFrame, passive);
    window.addEventListener("resize", followNextFrame, passive);
    this.attach();
  }

  update(video: HTMLVideoElement | null, status: SessionStatus | null): void {
    this.video = video;
    this.status = status;
    const box = video?.getBoundingClientRect();
    const fits = box && box.width >= MIN_VIDEO_WIDTH_PX && box.height >= MIN_VIDEO_HEIGHT_PX;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    // A viewer who has to click can't be left without the button, wherever the video is.
    const mustShow = mustShowNotice(noticeFor(status));
    const isHeld = this.isMoving || this.dragOffset !== null;
    const hasSpot = box && fits && (isHeld || this.isSpotClear(box, video, viewport));
    if (!status || !(hasSpot || mustShow)) {
      this.stack.style.display = "none";
      this.isHovering = false;
      return;
    }
    this.stack.style.display = "flex";
    this.renderPill(status);
    this.renderReactions();
    this.renderCard(status);
    // Opening up mustn't shift it from under the pointer, or it would close and open again.
    if (this.isHovering && !isHeld) return;
    // Without a video big enough to sit on, the window will do.
    const target = box && fits ? box : new DOMRect(0, 0, viewport.width, viewport.height);
    // The spot the viewer chose is a spot on the video. Off it, the card goes where it's always
    // found, the top right, rather than wherever that spot lands in the window: at the bottom
    // of a narrow window it's easy to miss, or off it altogether.
    if (hasSpot) this.place(target);
    else this.place(target, this.clearOfSiteBar(viewport), null);
  }

  /** Lets the viewer put the badge where it doesn't hide a player's own buttons. */
  startMoving(): void {
    if (this.isMoving) return;
    this.isMoving = true;
    this.positionBeforeMove = this.position;

    const { style } = this.pill;
    style.outline = `2px solid ${ACCENT}`;
    this.pill.tabIndex = 0;
    this.pill.setAttribute("role", "group");
    this.pill.setAttribute("aria-label", translate(this.messages, "badgeMoveHint"));
    this.movePanel.style.display = "flex";
    this.pill.focus();
  }

  /** A brief word about what someone else just did. */
  flash(key: string, substitutions?: string[]): void {
    this.flashMessage.textContent = translate(this.messages, key, substitutions);
    this.flashMessage.style.display = "block";
    if (this.flashTimer !== null) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashMessage.style.display = "none";
      this.flashTimer = null;
    }, FLASH_MS);
  }

  /** Whether reactions are on: the row to send one is offered, and other people's are drawn. */
  setReactions(shown: boolean): void {
    if (shown === this.reactionsShown) return;
    this.reactionsShown = shown;
    if (!shown) {
      this.layer.clear();
      this.onScreen = [];
    }
    this.renderReactions();
  }

  /** Someone's reaction, rising beside the badge. `name` is null when it isn't known yet. */
  showReaction(id: ReactionId, name: string | null, from: string): void {
    if (!this.reactionsShown || !this.video || this.stack.style.display === "none") return;
    const next = admit(this.onScreen, from, Date.now(), document.hidden);
    if (!next) return;
    this.onScreen = next;
    this.layer.show(
      id,
      name,
      this.stack.getBoundingClientRect(),
      this.video.getBoundingClientRect(),
    );
  }

  stop(): void {
    if (this.cooldownTimer !== null) clearTimeout(this.cooldownTimer);
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.layer.clear();
    if (this.flashTimer !== null) clearTimeout(this.flashTimer);
    if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest);
    this.listeners.abort();
    this.host.remove();
  }

  private followNextFrame(): void {
    if (this.frameRequest !== null) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = null;
      this.update(this.video, this.status);
    });
  }

  /** Only a fullscreen element's descendants are drawn, so the badge has to move inside it. */
  private attach(): void {
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen !== this.video ? fullscreen : document.documentElement;
    if (this.host.parentElement !== parent) parent.append(this.host);
  }

  private isSpotClear(
    box: DOMRect,
    video: HTMLVideoElement | null,
    viewport: { width: number; height: number },
  ): boolean {
    if (!isVideoOnScreen(box, viewport)) return false;
    const spot: Box = spotOf(box, CHIP_AT_REST, this.position);
    if (!isSpotOnScreen(spot, viewport)) return false;
    // Every corner, because the chip can be half under a bar with its middle in the clear.
    const [right, bottom] = [spot.left + spot.width - 1, spot.top + spot.height - 1];
    return [
      [spot.left, spot.top],
      [right, spot.top],
      [spot.left, bottom],
      [right, bottom],
    ].every(([x = 0, y = 0]) => siteBarAt(x, y, this.host, video) === null);
  }

  /** How far down a card has to start to keep clear of a bar along the top of the window. */
  private clearOfSiteBar(viewport: { width: number; height: number }): number | undefined {
    const bar = siteBarAt(viewport.width - 100, TOP_OF_WINDOW_PX, this.host, this.video);
    return bar ? bar.bottom + BELOW_BAR_PX : undefined;
  }

  private place(box: DOMRect, minTop?: number, position = this.position): void {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const { horizontal, vertical } = placeBadge(
      box,
      CHIP_AT_REST,
      viewport,
      position,
      minTop,
      STACK_MAX_WIDTH_PX,
    );

    const { style } = this.stack;
    style.left = horizontal.side === "left" ? `${horizontal.px}px` : "auto";
    style.right = horizontal.side === "right" ? `${horizontal.px}px` : "auto";
    style.top = vertical.side === "top" ? `${vertical.px}px` : "auto";
    style.bottom = vertical.side === "bottom" ? `${vertical.px}px` : "auto";
    style.alignItems = horizontal.side === "right" ? "flex-end" : "flex-start";
    // The card opens away from the edge, so the pill itself stays where it was put.
    style.flexDirection = vertical.side === "bottom" ? "column-reverse" : "column";
  }

  private renderPill(status: SessionStatus): void {
    const line = statusLine(status);
    const label = translate(this.messages, line.key);
    // Out of everyone, how many are on this video, when someone isn't.
    const here = status.peers - status.othersBehind;
    const count =
      status.peers <= 0
        ? ""
        : here < status.peers
          ? `${Math.max(here, 1)}/${status.peers}`
          : String(status.peers);
    const text = `${label} ${count}`;
    if (text !== this.lastPillText) {
      this.lastPillText = text;
      this.lastChangeAt = Date.now();
      this.pillText.textContent = label;
      this.pillCount.textContent = count;
      this.lastPillLabel =
        status.peers <= 0
          ? label
          : here < status.peers
            ? `${label}. ${translate(this.messages, "othersBehind", [String(Math.max(here, 1)), String(status.peers)])}`
            : `${label}. ${translate(this.messages, "people", [String(status.peers)])}`;
      if (!this.isMoving) this.pill.setAttribute("aria-label", this.lastPillLabel);
    }
    this.dot.style.background = TONE_COLORS[line.tone];

    const isDragging = this.dragOffset !== null;
    const isOpen = this.isHovering || this.isMoving;
    // Hiding the words rather than dimming them keeps what's left readable on any picture.
    // A live stream is amber for good, so it quiets down too, or its words would sit over it.
    const isSettled = line.tone === "ok" || line.key === "liveStream";
    const isCalm = !isOpen && isSettled && Date.now() - this.lastChangeAt > QUIET_AFTER_MS;
    this.pill.style.background = isCalm ? OVERLAY_BACKGROUND_QUIET : OVERLAY_BACKGROUND;
    // Dragging hides them too, or the chip would jump when it crosses the middle of the video.
    this.pillText.style.display = isCalm || isDragging ? "none" : "inline";
    this.grip.style.display = isOpen || isDragging ? "block" : "none";

    const hint = this.isMoving
      ? ""
      : isDragging
        ? "badgeDragCancel"
        : isOpen
          ? "badgeDragHint"
          : "";
    this.pillHint.style.display = hint ? "block" : "none";
    if (hint) this.setText(this.pillHint, translate(this.messages, hint));
  }

  /**
   * The row is out whenever the badge is open, under the pointer or with the keyboard in it.
   * Put away it's shrunk to nothing rather than removed, so the keyboard can still reach it.
   */
  private renderReactions(): void {
    const { style } = this.reactionRow;
    if (!this.reactionsShown || this.isMoving) {
      style.display = "none";
      return;
    }
    // Asked each time, not remembered: hiding a focused row doesn't always say focus left.
    const hasFocus = this.reactionButtons.some((button) => button.matches(":focus"));
    const isOut = (this.isHovering || hasFocus) && this.dragOffset === null;
    style.display = "flex";
    style.position = isOut ? "static" : "absolute";
    style.transform = isOut ? "none" : "scale(0.01)";
    style.opacity = isOut ? "1" : "0";
    style.pointerEvents = isOut ? "auto" : "none";
  }

  private react(id: ReactionId): void {
    const now = Date.now();
    if (!canSend(this.lastReactionAt, now)) return;
    this.lastReactionAt = now;
    this.setCooling(true);
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.setCooling(false);
    }, COOLDOWN_MS);
    this.showReaction(id, translate(this.messages, "reactionYou"), OWN_REACTION);
    this.onReact(id);
  }

  /** Not `disabled`, which would drop the keyboard's place in the row. */
  private setCooling(isCooling: boolean): void {
    for (const button of this.reactionButtons) {
      button.setAttribute("aria-disabled", String(isCooling));
      button.style.opacity = isCooling ? "0.45" : "1";
      button.style.cursor = isCooling ? "default" : "pointer";
    }
  }

  private buildReactions(): void {
    this.reactionRow.setAttribute("role", "toolbar");
    this.reactionRow.setAttribute("aria-label", translate(this.messages, "reactionsLabel"));
    this.reactionRow.style.cssText = `display: none; gap: 2px; box-sizing: border-box; padding: 4px;
      border-radius: 14px; background: ${OVERLAY_BACKGROUND}; border: 1px solid ${OVERLAY_BORDER};
      transform-origin: top right;`;
    for (const id of Object.keys(REACTION_EMOJI) as ReactionId[]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.reaction = id;
      button.textContent = REACTION_EMOJI[id];
      button.setAttribute("aria-label", translate(this.messages, REACTION_LABELS[id]));
      button.setAttribute("aria-disabled", "false");
      // One stop for the Tab key; the arrow keys move along the row from there.
      button.tabIndex = this.reactionButtons.length === 0 ? 0 : -1;
      button.style.cssText = `all: unset; box-sizing: border-box; width: 44px; height: 44px;
        display: flex; align-items: center; justify-content: center; border-radius: 10px;
        font-size: 22px; line-height: 1; cursor: pointer; pointer-events: auto;
        outline: 2px solid transparent; outline-offset: -2px;`;
      button.addEventListener("focus", () => (button.style.outlineColor = TEXT));
      button.addEventListener("blur", () => (button.style.outlineColor = "transparent"));
      button.addEventListener("pointerenter", () => (button.style.background = OVERLAY_BORDER));
      button.addEventListener("pointerleave", () => (button.style.background = "transparent"));
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.react(id);
      });
      this.reactionButtons.push(button);
      this.reactionRow.append(button);
    }
  }

  private connectReactions(signal: AbortSignal): void {
    const row = this.reactionRow;
    for (const type of SWALLOWED_EVENTS) {
      row.addEventListener(type, (event) => event.stopPropagation(), { signal });
    }
    // A press with the pointer mustn't take the keyboard's focus: the row would stay out
    // after the pointer left, and the player's keys would land on it.
    row.addEventListener("mousedown", (event) => event.preventDefault(), { signal });
    row.addEventListener("focusin", () => this.renderReactions(), { signal });
    // Once focus has settled, since it's between two places while this is heard.
    row.addEventListener("focusout", () => setTimeout(() => this.renderReactions()), { signal });
    // Players listen for these keys to seek and to play, so they stop here.
    const stopKeys = (event: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "Enter", " "].includes(event.key)) return;
      event.stopPropagation();
      if (event.type !== "keydown" || !event.key.startsWith("Arrow")) return;
      event.preventDefault();
      const buttons = this.reactionButtons;
      const at = buttons.findIndex((button) => button.matches(":focus"));
      const step = event.key === "ArrowRight" ? 1 : -1;
      const next = buttons[(at + step + buttons.length) % buttons.length];
      if (!next) return;
      for (const button of buttons) button.tabIndex = button === next ? 0 : -1;
      next.focus();
    };
    row.addEventListener("keydown", stopKeys, { signal });
    row.addEventListener("keyup", stopKeys, { signal });
  }

  /** Open as soon as the pointer is on the chip or the row, shut a moment after it's off both. */
  private setHovering(isOver: boolean): void {
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (isOver || !this.reactionsShown) {
      this.isHovering = isOver;
      this.update(this.video, this.status);
      return;
    }
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      this.isHovering = false;
      this.update(this.video, this.status);
    }, HOVER_GAP_MS);
  }

  private renderCard(status: SessionStatus): void {
    const notice = this.isMoving ? null : noticeFor(status);
    this.card.style.display = notice ? "flex" : "none";
    if (!notice) return;

    this.cardDot.style.background = TONE_COLORS[notice.tone];
    this.setText(
      this.cardTitle,
      translate(this.messages, notice.titleKey, notice.titleSubstitutions),
    );
    this.setText(this.cardDetail, notice.detail ?? "");
    this.cardDetail.style.display = notice.detail ? "-webkit-box" : "none";
    this.setText(this.cardHost, notice.host ?? "");
    this.cardHost.style.display = notice.host ? "block" : "none";
    this.setText(this.cardBody, translate(this.messages, notice.bodyKey, notice.bodySubstitutions));

    this.actionShown = notice.action;
    const show = (button: HTMLElement, isShown: boolean) => {
      button.style.display = isShown ? "block" : "none";
    };
    show(this.action, hasMainButton(notice));
    show(this.returnAction, notice.action === "bring" && notice.noWayBack !== true);
    show(this.bringAction, notice.action === "go" && status.hasVideo);
    show(this.leaveAction, isVideoChangeAction(notice) || notice.action === "leave");
    const hasSecondary = isVideoChangeAction(notice) || notice.action === "leave";
    this.secondaryActions.style.display = hasSecondary ? "flex" : "none";
    // Alone on its row, leaving sits at the end, where a way out is expected.
    this.secondaryActions.style.justifyContent =
      notice.action === "return" || notice.action === "leave" ? "flex-end" : "flex-start";
    const isStarting = notice.action === "play" && Date.now() - this.joinPressedAt < JOIN_PRESS_MS;
    this.setText(this.action, this.actionLabel(notice, status, isStarting));
    this.action.style.opacity = isStarting ? "0.7" : "1";
    this.action.style.cursor = isStarting ? "progress" : "pointer";
  }

  private actionLabel(notice: Notice, status: SessionStatus, isStarting: boolean): string {
    switch (notice.action) {
      case "bring":
        return translate(this.messages, "bring");
      case "return":
        return translate(this.messages, "backToRoom");
      case "pause":
        return translate(this.messages, "pauseVideo");
      case "dismiss":
        return translate(this.messages, "gotIt");
      case "go":
        return translate(this.messages, "goThere");
      default:
        return translate(this.messages, isStarting ? "starting" : "join");
    }
  }

  /** Only writes real changes, so a screen reader announces each one once. */
  private setText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) element.textContent = text;
  }

  private connectMoving(): void {
    const { signal } = this.listeners;
    for (const target of [this.pill, this.movePanel]) {
      for (const type of SWALLOWED_EVENTS) {
        target.addEventListener(type, (event) => event.stopPropagation(), { signal });
      }
    }

    this.connectReactions(signal);
    for (const target of [this.pill, this.reactionRow]) {
      target.addEventListener("pointerenter", () => this.setHovering(true), { signal });
      target.addEventListener("pointerleave", () => this.setHovering(false), { signal });
    }
    this.pill.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0 || !this.video) return;
        event.preventDefault();
        const spot = this.restingChip();
        this.dragOffset = { x: event.clientX - spot.left, y: event.clientY - spot.top };
        this.dragPointerId = event.pointerId;
        this.hasDragged = false;
        this.positionBeforeDrag = this.position;
        this.pill.setPointerCapture(event.pointerId);
        this.pill.style.cursor = "grabbing";
      },
      { signal },
    );
    this.pill.addEventListener(
      "pointermove",
      (event) => {
        if (!this.dragOffset || !this.video) return;
        const box = this.video.getBoundingClientRect();
        this.position = positionAt(
          box,
          CHIP_AT_REST,
          event.clientX - this.dragOffset.x,
          event.clientY - this.dragOffset.y,
        );
        this.hasDragged = true;
        if (this.status) this.renderPill(this.status);
        this.place(box);
      },
      { signal },
    );
    this.pill.addEventListener(
      "pointerup",
      () => {
        if (!this.dragOffset) return;
        const hadDragged = this.hasDragged;
        this.stopDragging();
        // In move mode, saving waits for the viewer to say they're done.
        if (hadDragged && !this.isMoving) this.onPositionChange(this.position);
      },
      { signal },
    );
    this.pill.addEventListener("pointercancel", () => this.cancelDragging(), { signal });

    // On the window, and first, because players listen for arrow keys to seek.
    window.addEventListener(
      "keydown",
      (event) => {
        if (this.dragOffset && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.cancelDragging();
          return;
        }
        if (!this.isMoving) return;
        const moved = nudge(this.currentPosition(), event.key);
        if (moved) this.position = moved;
        else if (event.key === "Escape") this.cancelMoving();
        else if (event.key === "Enter" && !this.isFocusOnButton()) this.finishMoving();
        else return;

        event.preventDefault();
        event.stopPropagation();
        if (this.video) this.place(this.video.getBoundingClientRect());
      },
      { capture: true, signal },
    );
  }

  private isFocusOnButton(): boolean {
    const root = this.stack.getRootNode() as ShadowRoot;
    return root.activeElement instanceof HTMLButtonElement;
  }

  /** Where the chip would be at its resting size, going by the edge it's anchored to. */
  private restingChip(): { left: number; top: number } {
    const pill = this.pill.getBoundingClientRect();
    const isAnchoredRight = this.stack.style.right !== "auto";
    const left = isAnchoredRight ? pill.right - CHIP_AT_REST.width : pill.left;
    return { left, top: pill.top };
  }

  private stopDragging(): void {
    if (this.dragPointerId !== null && this.pill.hasPointerCapture(this.dragPointerId)) {
      this.pill.releasePointerCapture(this.dragPointerId);
    }
    this.dragPointerId = null;
    this.dragOffset = null;
    this.pill.style.cursor = "grab";
    this.update(this.video, this.status);
  }

  private cancelDragging(): void {
    if (!this.dragOffset) return;
    this.position = this.positionBeforeDrag;
    this.stopDragging();
    if (this.video) this.place(this.video.getBoundingClientRect());
  }

  /** The default spot has no stored position, so read where the chip really is. */
  private currentPosition(): BadgePosition {
    if (this.position || !this.video) return this.position ?? { x: 1, y: 0 };
    const { left, top } = this.restingChip();
    return positionAt(this.video.getBoundingClientRect(), CHIP_AT_REST, left, top);
  }

  private endMoving(): void {
    this.isMoving = false;
    this.dragOffset = null;
    const { style } = this.pill;
    style.cursor = "grab";
    style.outline = "none";
    this.pill.removeAttribute("tabindex");
    this.pill.setAttribute("role", "status");
    this.pill.setAttribute("aria-label", this.lastPillLabel);
    this.movePanel.style.display = "none";
    this.lastChangeAt = Date.now();
    if (this.video) this.place(this.video.getBoundingClientRect());
  }

  private finishMoving(): void {
    this.endMoving();
    this.onPositionChange(this.position);
  }

  private cancelMoving(): void {
    this.position = this.positionBeforeMove;
    this.endMoving();
  }

  private resetPosition(): void {
    this.position = null;
    this.finishMoving();
  }

  private createPanelButton(key: string, isPrimary: boolean, onClick: () => void): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = translate(this.messages, key);
    button.style.cssText = `all: unset; box-sizing: border-box; min-height: 44px; padding: 12px 16px;
      border-radius: 8px; font: 700 14px ${FONT}; cursor: pointer; pointer-events: auto;
      outline: 2px solid transparent; outline-offset: 2px; text-align: center;`;
    button.style.background = isPrimary ? ACCENT : "transparent";
    button.style.color = isPrimary ? ON_ACCENT : TEXT;
    if (!isPrimary) button.style.boxShadow = `inset 0 0 0 1px ${BUTTON_BORDER}`;
    button.addEventListener("focus", () => (button.style.outlineColor = TEXT));
    button.addEventListener("blur", () => (button.style.outlineColor = "transparent"));
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  /** Six dots, the usual sign that something can be dragged. */
  private buildGrip(): void {
    const namespace = this.grip.namespaceURI;
    this.grip.setAttribute("viewBox", "0 0 10 16");
    this.grip.setAttribute("width", "10");
    this.grip.setAttribute("height", "16");
    this.grip.setAttribute("aria-hidden", "true");
    this.grip.style.cssText = "display: none; flex: none; margin-left: -2px;";
    for (const cx of [2, 8]) {
      for (const cy of [3, 8, 13]) {
        const dot = document.createElementNS(namespace, "circle");
        dot.setAttribute("cx", String(cx));
        dot.setAttribute("cy", String(cy));
        dot.setAttribute("r", "1.4");
        dot.setAttribute("fill", MUTED);
        this.grip.append(dot);
      }
    }
  }

  private buildContent(root: ShadowRoot): void {
    this.stack.style.cssText = `position: fixed; display: none; flex-direction: column;
      align-items: flex-end; gap: 10px; max-width: ${STACK_MAX_WIDTH_PX}px; font-family: ${FONT}; color: ${TEXT};`;

    this.pill.setAttribute("role", "status");
    this.pill.style.cssText = `display: flex; align-items: center; gap: 8px; box-sizing: border-box;
      height: ${CHIP_AT_REST.height}px; padding: 0 12px; border-radius: 999px;
      background: ${OVERLAY_BACKGROUND}; border: 1px solid ${OVERLAY_BORDER}; font-size: 14px;
      font-weight: 600; outline-offset: 2px; pointer-events: auto; cursor: grab; touch-action: none;
      user-select: none; transition: background-color 400ms;`;
    this.dot.style.cssText = "width: 8px; height: 8px; border-radius: 50%; flex: none;";
    this.pillCount.style.fontVariantNumeric = "tabular-nums";
    this.buildGrip();
    this.pill.append(this.grip, this.dot, this.pillText, this.pillCount);

    this.pillHint.style.cssText = `display: none; padding: 6px 10px; border-radius: 8px;
      background: ${OVERLAY_BACKGROUND}; font-size: 12px; color: ${TEXT_SECONDARY};`;

    this.flashMessage.setAttribute("role", "status");
    this.flashMessage.style.cssText = `display: none; padding: 8px 12px; border-radius: 12px;
      background: ${OVERLAY_BACKGROUND}; border: 1px solid ${OVERLAY_BORDER}; font-size: 13px;
      font-weight: 500;`;

    this.card.setAttribute("role", "alert");
    this.card.style.cssText = `display: none; flex-direction: column; gap: 6px; box-sizing: border-box;
      width: ${CARD_WIDTH_PX}px; padding: 14px; border-radius: 14px; background: ${OVERLAY_BACKGROUND};
      border: 1px solid ${OVERLAY_BORDER};`;

    const title = document.createElement("span");
    title.style.cssText = "display: flex; align-items: center; gap: 8px;";
    this.cardDot.style.cssText = "width: 8px; height: 8px; border-radius: 50%; flex: none;";
    this.cardTitle.style.cssText = "font-size: 14px; font-weight: 700;";
    title.append(this.cardDot, this.cardTitle);

    // It's a web page's title, so it can be any length.
    this.cardDetail.style.cssText = `font-size: 13px; font-weight: 600; line-height: 1.4;
      overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;`;
    this.cardHost.style.cssText = `font-size: 12px; color: ${TEXT_SECONDARY}; overflow: hidden;
      white-space: nowrap; text-overflow: ellipsis;`;
    this.cardBody.style.cssText = `font-size: 13px; line-height: 1.5; color: ${TEXT_SECONDARY};`;

    this.action.type = "button";
    this.action.style.cssText = `all: unset; box-sizing: border-box; display: none; width: 100%;
      text-align: center; min-height: 44px; padding: 12px 18px;
      border-radius: 8px; background: ${ACCENT}; color: ${ON_ACCENT}; font: 700 14px ${FONT};
      cursor: pointer; pointer-events: auto; outline: 2px solid transparent; outline-offset: 2px;`;
    this.action.addEventListener("focus", () => (this.action.style.outlineColor = TEXT));
    this.action.addEventListener("blur", () => (this.action.style.outlineColor = "transparent"));

    const actions = document.createElement("div");
    actions.style.cssText = "display: flex; flex-direction: column; gap: 8px; margin-top: 6px;";
    this.secondaryActions.style.cssText = "display: none; gap: 8px; align-items: stretch;";
    this.secondaryActions.append(this.returnAction, this.bringAction, this.leaveAction);
    actions.append(this.action, this.secondaryActions);
    this.card.append(title, this.cardDetail, this.cardHost, this.cardBody, actions);

    this.movePanel.style.cssText = `display: none; flex-direction: column; gap: 10px; padding: 12px 14px;
      border-radius: 14px; background: ${OVERLAY_BACKGROUND}; border: 1px solid ${OVERLAY_BORDER};
      pointer-events: auto;`;
    const hint = document.createElement("span");
    hint.textContent = translate(this.messages, "badgeMoveHint");
    hint.style.cssText = `font-size: 13px; line-height: 1.5; color: ${TEXT_SECONDARY};`;
    const buttons = document.createElement("div");
    buttons.style.cssText = "display: flex; gap: 8px;";
    buttons.append(
      this.createPanelButton("badgeDone", true, () => this.finishMoving()),
      this.createPanelButton("badgeReset", false, () => this.resetPosition()),
    );
    this.movePanel.append(hint, buttons);

    this.buildReactions();
    this.stack.append(
      this.pill,
      this.reactionRow,
      this.pillHint,
      this.flashMessage,
      this.card,
      this.movePanel,
    );
    root.append(this.stack);
  }
}
