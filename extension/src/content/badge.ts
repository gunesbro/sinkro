import { translate, type Messages } from "../i18n";
import type { SessionStatus } from "../messages";
import { noticeFor, statusLine, type Tone } from "../status";
import {
  isVideoOnScreen,
  nudge,
  placeBadge,
  positionAt,
  type BadgePosition,
} from "./badge-position";
import { markOwnElement } from "./detection/discovery";
import {
  ACCENT,
  BUTTON_BORDER,
  DANGER,
  FAINT,
  FONT,
  OK,
  ON_ACCENT,
  OVERLAY_BACKGROUND,
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
/** A pointer on the badge in move mode must never reach the player underneath. */
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
  onPositionChange: (position: BadgePosition | null) => void;
};

/**
 * Always-visible sync status over the video, with a card for anything that needs the
 * viewer. The status lets clicks through to the player, except in move mode, which the
 * viewer asks for from the popup. Styled through the CSSOM because a page's CSP can block
 * style elements.
 */
export class VideoBadge {
  private readonly host = document.createElement("div");
  private readonly stack = document.createElement("div");
  private readonly pill = document.createElement("div");
  private readonly dot = document.createElement("span");
  private readonly pillText = document.createElement("span");
  private readonly flashMessage = document.createElement("div");
  private readonly card = document.createElement("div");
  private readonly cardDot = document.createElement("span");
  private readonly cardTitle = document.createElement("span");
  private readonly cardBody = document.createElement("span");
  private readonly action = document.createElement("button");
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
  private dragOffset: { x: number; y: number } | null = null;
  private lastChangeAt = 0;
  private lastPillText = "";
  private lastPillLabel = "";
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private joinPressedAt = Number.NEGATIVE_INFINITY;

  constructor(options: BadgeOptions) {
    this.messages = options.messages;
    this.position = options.position;
    this.onPositionChange = options.onPositionChange;

    markOwnElement(this.host);
    this.host.style.cssText = `all: initial; position: fixed; inset: 0; z-index: ${TOP_LAYER};
      pointer-events: none;`;
    const root = this.host.attachShadow({ mode: "closed" });
    this.buildContent(root);

    this.action.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Answer the click at once: playback can take a moment to start.
      this.joinPressedAt = Date.now();
      options.onPlay();
      if (this.video) this.update(this.video, this.status);
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
    const mustShow = status !== null && noticeFor(status)?.action === "play";
    if (!box || !fits || !status || !(mustShow || isVideoOnScreen(box, viewport))) {
      this.stack.style.display = "none";
      return;
    }
    this.stack.style.display = "flex";
    this.renderPill(status);
    this.renderCard(status);
    this.place(box);
  }

  /** Lets the viewer put the badge where it doesn't hide a player's own buttons. */
  startMoving(): void {
    if (this.isMoving) return;
    this.isMoving = true;
    this.positionBeforeMove = this.position;

    const { style } = this.pill;
    style.pointerEvents = "auto";
    style.cursor = "grab";
    style.touchAction = "none";
    style.outline = `2px solid ${ACCENT}`;
    this.pill.tabIndex = 0;
    this.pill.setAttribute("role", "group");
    this.pill.setAttribute("aria-label", translate(this.messages, "badgeMoveHint"));
    this.movePanel.style.display = "flex";
    this.pill.focus();
  }

  /** A brief word about what someone else just did. */
  flash(key: string): void {
    this.flashMessage.textContent = translate(this.messages, key);
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

  private place(box: DOMRect): void {
    const pill = this.pill.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const { horizontal, vertical } = placeBadge(box, pill, viewport, this.position);

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
    const text = status.peers > 0 ? `${label} · ${status.peers}` : label;
    if (text !== this.lastPillText) {
      this.lastPillText = text;
      this.lastChangeAt = Date.now();
      this.pillText.textContent = text;
      this.lastPillLabel =
        status.peers > 0
          ? `${label}. ${translate(this.messages, "people", [String(status.peers)])}`
          : label;
      if (!this.isMoving) this.pill.setAttribute("aria-label", this.lastPillLabel);
    }
    this.dot.style.background = TONE_COLORS[line.tone];

    // Hiding the words rather than dimming them keeps what's left readable on any picture.
    const isCalm =
      !this.isMoving && line.tone === "ok" && Date.now() - this.lastChangeAt > QUIET_AFTER_MS;
    this.pillText.style.display = isCalm ? "none" : "inline";
    this.pill.style.padding = isCalm ? "0 10px" : "0 12px";
  }

  private renderCard(status: SessionStatus): void {
    const notice = this.isMoving ? null : noticeFor(status);
    this.card.style.display = notice ? "flex" : "none";
    if (!notice) return;

    this.cardDot.style.background = TONE_COLORS[notice.tone];
    this.setText(this.cardTitle, translate(this.messages, notice.titleKey));
    this.setText(this.cardBody, translate(this.messages, notice.bodyKey));
    this.action.style.display = notice.action === "play" ? "block" : "none";
    const isStarting = Date.now() - this.joinPressedAt < JOIN_PRESS_MS;
    this.setText(this.action, translate(this.messages, isStarting ? "starting" : "join"));
    this.action.style.opacity = isStarting ? "0.7" : "1";
    this.action.style.cursor = isStarting ? "progress" : "pointer";
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
      "pointerdown",
      (event) => {
        event.preventDefault();
        const pill = this.pill.getBoundingClientRect();
        this.dragOffset = { x: event.clientX - pill.left, y: event.clientY - pill.top };
        this.pill.setPointerCapture(event.pointerId);
        this.pill.style.cursor = "grabbing";
      },
      { signal },
    );
    this.pill.addEventListener(
      "pointermove",
      (event) => {
        if (!this.dragOffset || !this.video) return;
        this.position = positionAt(
          this.video.getBoundingClientRect(),
          this.pill.getBoundingClientRect(),
          event.clientX - this.dragOffset.x,
          event.clientY - this.dragOffset.y,
        );
        this.place(this.video.getBoundingClientRect());
      },
      { signal },
    );
    const endDrag = () => {
      this.dragOffset = null;
      if (this.isMoving) this.pill.style.cursor = "grab";
    };
    this.pill.addEventListener("pointerup", endDrag, { signal });
    this.pill.addEventListener("pointercancel", endDrag, { signal });

    // On the window, and first, because players listen for arrow keys to seek.
    window.addEventListener(
      "keydown",
      (event) => {
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

  /** The default spot has no stored position, so read where the pill really is. */
  private currentPosition(): BadgePosition {
    if (this.position || !this.video) return this.position ?? { x: 1, y: 0 };
    const pill = this.pill.getBoundingClientRect();
    return positionAt(this.video.getBoundingClientRect(), pill, pill.left, pill.top);
  }

  private endMoving(): void {
    this.isMoving = false;
    this.dragOffset = null;
    const { style } = this.pill;
    style.pointerEvents = "none";
    style.cursor = "";
    style.touchAction = "";
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
    button.addEventListener("click", onClick);
    return button;
  }

  private buildContent(root: ShadowRoot): void {
    this.stack.style.cssText = `position: fixed; display: none; flex-direction: column;
      align-items: flex-end; gap: 10px; max-width: 300px; font-family: ${FONT}; color: ${TEXT};`;

    this.pill.setAttribute("role", "status");
    this.pill.style.cssText = `display: flex; align-items: center; gap: 8px; height: 32px;
      padding: 0 12px; border-radius: 999px; background: ${OVERLAY_BACKGROUND};
      border: 1px solid ${OVERLAY_BORDER}; font-size: 14px; font-weight: 600; outline-offset: 2px;`;
    this.dot.style.cssText = "width: 8px; height: 8px; border-radius: 50%; flex: none;";
    this.pill.append(this.dot, this.pillText);

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

    this.cardBody.style.cssText = `font-size: 13px; line-height: 1.5; color: ${TEXT_SECONDARY};`;

    this.action.type = "button";
    this.action.style.cssText = `all: unset; box-sizing: border-box; display: none;
      align-self: flex-start; min-height: 44px; margin-top: 6px; padding: 12px 18px;
      border-radius: 8px; background: ${ACCENT}; color: ${ON_ACCENT}; font: 700 14px ${FONT};
      cursor: pointer; pointer-events: auto; outline: 2px solid transparent; outline-offset: 2px;`;
    this.action.addEventListener("focus", () => (this.action.style.outlineColor = TEXT));
    this.action.addEventListener("blur", () => (this.action.style.outlineColor = "transparent"));

    this.card.append(title, this.cardBody, this.action);

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

    this.stack.append(this.pill, this.flashMessage, this.card, this.movePanel);
    root.append(this.stack);
  }
}
