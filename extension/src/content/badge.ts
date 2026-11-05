import { translate, type Messages } from "../i18n";
import type { SessionStatus } from "../messages";
import {
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
import { markOwnElement } from "./detection/discovery";
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
  onPositionChange: (position: BadgePosition | null) => void;
};

function parentAcrossShadow(node: Element): Element | null {
  if (node.parentElement) return node.parentElement;
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

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
  private readonly cardBody = document.createElement("span");
  private readonly action = document.createElement("button");
  private readonly returnAction: HTMLElement;
  private readonly bringAction: HTMLElement;
  private readonly leaveAction: HTMLElement;
  private readonly movePanel = document.createElement("div");
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

    markOwnElement(this.host);
    this.host.style.cssText = `all: initial; position: fixed; inset: 0; z-index: ${TOP_LAYER};
      pointer-events: none;`;
    const root = this.host.attachShadow({ mode: "closed" });
    this.returnAction = this.createPanelButton("backToRoom", false, options.onGo);
    this.bringAction = this.createPanelButton("bring", false, options.onBring);
    this.leaveAction = this.createPanelButton("leave", false, options.onLeave);
    this.leaveAction.style.color = DANGER;
    this.buildContent(root);

    this.action.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.actionShown === "bring") {
        options.onBring();
      } else if (this.actionShown === "go" || this.actionShown === "return") {
        options.onGo();
      } else if (this.actionShown === "pause") {
        options.onPause();
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
    this.renderCard(status);
    // Opening up mustn't shift it from under the pointer, or it would close and open again.
    if (this.isHovering && !isHeld) return;
    // Without a video big enough to sit on, the window will do.
    const target = box && fits ? box : new DOMRect(0, 0, viewport.width, viewport.height);
    this.place(target, hasSpot ? undefined : this.clearOfSiteBar(viewport));
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

  stop(): void {
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

  private place(box: DOMRect, minTop?: number): void {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const { horizontal, vertical } = placeBadge(box, CHIP_AT_REST, viewport, this.position, minTop);

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
    const count = status.peers > 0 ? String(status.peers) : "";
    const text = `${label} ${count}`;
    if (text !== this.lastPillText) {
      this.lastPillText = text;
      this.lastChangeAt = Date.now();
      this.pillText.textContent = label;
      this.pillCount.textContent = count;
      this.lastPillLabel =
        status.peers > 0
          ? `${label}. ${translate(this.messages, "people", [String(status.peers)])}`
          : label;
      if (!this.isMoving) this.pill.setAttribute("aria-label", this.lastPillLabel);
    }
    this.dot.style.background = TONE_COLORS[line.tone];

    const isDragging = this.dragOffset !== null;
    const isOpen = this.isHovering || this.isMoving;
    // Hiding the words rather than dimming them keeps what's left readable on any picture.
    const isCalm = !isOpen && line.tone === "ok" && Date.now() - this.lastChangeAt > QUIET_AFTER_MS;
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
    this.cardDetail.style.display = notice.detail ? "block" : "none";
    this.setText(this.cardBody, translate(this.messages, notice.bodyKey));

    this.actionShown = notice.action;
    const show = (button: HTMLElement, isShown: boolean) => {
      button.style.display = isShown ? "block" : "none";
    };
    show(
      this.action,
      (mustShowNotice(notice) && notice.action !== "leave") || notice.action === "pause",
    );
    show(this.returnAction, notice.action === "bring");
    show(this.bringAction, notice.action === "go" && status.hasVideo);
    show(this.leaveAction, isVideoChangeAction(notice) || notice.action === "leave");
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
      case "go":
        return translate(this.messages, "goToVideo", [status.videoChange?.host ?? ""]);
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

    this.pill.addEventListener(
      "pointerenter",
      () => {
        this.isHovering = true;
        this.update(this.video, this.status);
      },
      { signal },
    );
    this.pill.addEventListener(
      "pointerleave",
      () => {
        this.isHovering = false;
        this.update(this.video, this.status);
      },
      { signal },
    );
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
      outline: 2px solid transparent; outline-offset: 2px;`;
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
      align-items: flex-end; gap: 10px; max-width: 300px; font-family: ${FONT}; color: ${TEXT};`;

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
    this.card.style.cssText = `display: none; flex-direction: column; gap: 4px; padding: 12px 14px;
      border-radius: 14px; background: ${OVERLAY_BACKGROUND}; border: 1px solid ${OVERLAY_BORDER};`;

    const title = document.createElement("span");
    title.style.cssText = "display: flex; align-items: center; gap: 8px;";
    this.cardDot.style.cssText = "width: 8px; height: 8px; border-radius: 50%; flex: none;";
    this.cardTitle.style.cssText = "font-size: 14px; font-weight: 700;";
    title.append(this.cardDot, this.cardTitle);

    // It's a web page's title, so it can be any length.
    this.cardDetail.style.cssText = `font-size: 13px; font-weight: 600; line-height: 1.4;
      overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;`;
    this.cardBody.style.cssText = `font-size: 13px; line-height: 1.5; color: ${TEXT_SECONDARY};`;

    this.action.type = "button";
    this.action.style.cssText = `all: unset; box-sizing: border-box; display: none;
      min-height: 44px; padding: 12px 18px;
      border-radius: 8px; background: ${ACCENT}; color: ${ON_ACCENT}; font: 700 14px ${FONT};
      cursor: pointer; pointer-events: auto; outline: 2px solid transparent; outline-offset: 2px;`;
    this.action.addEventListener("focus", () => (this.action.style.outlineColor = TEXT));
    this.action.addEventListener("blur", () => (this.action.style.outlineColor = "transparent"));

    const actions = document.createElement("div");
    actions.style.cssText = "display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px;";
    actions.append(this.action, this.returnAction, this.bringAction, this.leaveAction);
    this.card.append(title, this.cardDetail, this.cardBody, actions);

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

    this.stack.append(this.pill, this.pillHint, this.flashMessage, this.card, this.movePanel);
    root.append(this.stack);
  }
}
