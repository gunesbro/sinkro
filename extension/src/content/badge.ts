import { translate, type Messages } from "../i18n";
import type { SessionStatus } from "../messages";
import { noticeFor, statusLine, type Tone } from "../status";
import { markOwnElement } from "./detection/discovery";
import {
  ACCENT,
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

const INSET_PX = 12;
/** On anything smaller, the badge would cover what it's reporting on. */
const MIN_VIDEO_WIDTH_PX = 240;
const MIN_VIDEO_HEIGHT_PX = 120;
/** All's well for this long, and the badge shrinks to its dot so the film has the screen. */
const QUIET_AFTER_MS = 5000;

const TONE_COLORS: Record<Tone, string> = {
  ok: OK,
  warn: ACCENT,
  danger: DANGER,
  idle: FAINT,
};

/**
 * Always-visible sync status over the video, with a card for anything that needs the
 * viewer. The status itself lets clicks through to the player. Styled through the CSSOM
 * because a page's CSP can block style elements.
 */
export class VideoBadge {
  private readonly host = document.createElement("div");
  private readonly stack = document.createElement("div");
  private readonly pill = document.createElement("div");
  private readonly dot = document.createElement("span");
  private readonly pillText = document.createElement("span");
  private readonly card = document.createElement("div");
  private readonly cardDot = document.createElement("span");
  private readonly cardTitle = document.createElement("span");
  private readonly cardBody = document.createElement("span");
  private readonly action = document.createElement("button");
  private readonly listeners = new AbortController();
  private video: HTMLVideoElement | null = null;
  private lastChangeAt = 0;
  private lastPillText = "";

  constructor(
    private readonly messages: Messages,
    onPlay: () => void,
  ) {
    markOwnElement(this.host);
    this.host.style.cssText = `all: initial; position: fixed; inset: 0; z-index: ${TOP_LAYER};
      pointer-events: none;`;
    const root = this.host.attachShadow({ mode: "closed" });
    this.buildContent(root);

    this.action.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onPlay();
    });
    document.addEventListener("fullscreenchange", () => this.attach(), {
      signal: this.listeners.signal,
    });
    this.attach();
  }

  update(video: HTMLVideoElement | null, status: SessionStatus | null): void {
    this.video = video;
    const box = video?.getBoundingClientRect();
    const fits = box && box.width >= MIN_VIDEO_WIDTH_PX && box.height >= MIN_VIDEO_HEIGHT_PX;
    if (!box || !fits || !status) {
      this.stack.style.display = "none";
      return;
    }

    const { style } = this.stack;
    style.display = "flex";
    style.top = `${Math.max(INSET_PX, box.top + INSET_PX)}px`;
    style.right = `${Math.max(INSET_PX, window.innerWidth - box.right + INSET_PX)}px`;

    this.renderPill(status);
    this.renderCard(status);
  }

  stop(): void {
    this.listeners.abort();
    this.host.remove();
  }

  /** Only a fullscreen element's descendants are drawn, so the badge has to move inside it. */
  private attach(): void {
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen !== this.video ? fullscreen : document.documentElement;
    if (this.host.parentElement !== parent) parent.append(this.host);
  }

  private renderPill(status: SessionStatus): void {
    const line = statusLine(status);
    const label = translate(this.messages, line.key);
    const text = status.peers > 0 ? `${label} · ${status.peers}` : label;
    if (text !== this.lastPillText) {
      this.lastPillText = text;
      this.lastChangeAt = Date.now();
      this.pillText.textContent = text;
      this.pill.setAttribute(
        "aria-label",
        status.peers > 0
          ? `${label}. ${translate(this.messages, "people", [String(status.peers)])}`
          : label,
      );
    }
    this.dot.style.background = TONE_COLORS[line.tone];

    // Hiding the words rather than dimming them keeps what's left readable on any picture.
    const isCalm = line.tone === "ok" && Date.now() - this.lastChangeAt > QUIET_AFTER_MS;
    this.pillText.style.display = isCalm ? "none" : "inline";
    this.pill.style.padding = isCalm ? "0 10px" : "0 12px";
  }

  private renderCard(status: SessionStatus): void {
    const notice = noticeFor(status);
    this.card.style.display = notice ? "flex" : "none";
    if (!notice) return;

    this.cardDot.style.background = TONE_COLORS[notice.tone];
    this.setText(this.cardTitle, translate(this.messages, notice.titleKey));
    this.setText(this.cardBody, translate(this.messages, notice.bodyKey));
    this.action.style.display = notice.action === "play" ? "block" : "none";
    this.setText(this.action, translate(this.messages, "join"));
  }

  /** Only writes real changes, so a screen reader announces each one once. */
  private setText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) element.textContent = text;
  }

  private buildContent(root: ShadowRoot): void {
    this.stack.style.cssText = `position: fixed; display: none; flex-direction: column;
      align-items: flex-end; gap: 10px; max-width: 300px; font-family: ${FONT}; color: ${TEXT};`;

    this.pill.setAttribute("role", "status");
    this.pill.style.cssText = `display: flex; align-items: center; gap: 8px; height: 32px;
      padding: 0 12px; border-radius: 999px; background: ${OVERLAY_BACKGROUND};
      border: 1px solid ${OVERLAY_BORDER}; font-size: 14px; font-weight: 600;`;
    this.dot.style.cssText = "width: 8px; height: 8px; border-radius: 50%; flex: none;";
    this.pill.append(this.dot, this.pillText);

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
    this.stack.append(this.pill, this.card);
    root.append(this.stack);
  }
}
