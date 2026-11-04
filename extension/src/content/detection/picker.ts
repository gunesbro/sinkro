import type { Messages } from "../../i18n";
import { translate } from "../../i18n";
import { markOwnElement, VideoDiscovery } from "./discovery";

const REPOSITION_INTERVAL_MS = 200;
/** A page changing its DOM constantly shouldn't turn into constant layout reads. */
const MIN_REFRESH_GAP_MS = 50;
const MIN_SIDE_PX = 40;
const ACCENT = "#F2B045";
const ON_ACCENT = "#1A1208";
const TEXT = "#F4EDE6";
const MUTED = "#A39589";
const BACKGROUND = "#110D0C";
const BORDER = "#3A2F2A";
const BUTTON_BORDER = "#4A3C35";
const FONT = "'DM Sans', system-ui, sans-serif";
const TOP_LAYER = "2147483647";

export type PickerEvents = {
  onPick: (video: HTMLVideoElement) => void;
  onCancel: () => void;
};

function formatDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds)) return null;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/**
 * Puts a real button over each video, so picking works from the keyboard and with a
 * screen reader as well as by clicking. Styled through the CSSOM because a page's CSP
 * can block style elements. Each frame shows its own buttons; the top frame adds the bar.
 */
export class VideoPicker {
  private readonly host = document.createElement("div");
  private readonly layer: HTMLElement;
  private readonly buttons = new Map<HTMLVideoElement, HTMLButtonElement>();
  private readonly listeners = new AbortController();
  private readonly discovery = new VideoDiscovery(() => this.scheduleRefresh());
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly messages: Messages,
    private readonly events: PickerEvents,
  ) {
    markOwnElement(this.host);
    const root = this.host.attachShadow({ mode: "closed" });
    this.layer = document.createElement("div");
    root.append(this.layer);
    this.host.style.cssText = `all: initial; position: fixed; inset: 0; z-index: ${TOP_LAYER}; pointer-events: none;`;
  }

  start(): void {
    document.documentElement.append(this.host);
    if (window === window.top) this.layer.append(this.createBar());

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.events.onCancel();
    };
    window.addEventListener("keydown", onKey, { capture: true, signal: this.listeners.signal });

    this.discovery.start();
    this.timer = setInterval(() => this.refresh(), REPOSITION_INTERVAL_MS);
    this.refresh();
    this.buttons.values().next().value?.focus();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.timer = null;
    this.refreshTimer = null;
    this.listeners.abort();
    this.discovery.stop();
    this.host.remove();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, MIN_REFRESH_GAP_MS);
  }

  private refresh(): void {
    const videos = new Set(this.discovery.current());
    for (const [video, button] of this.buttons) {
      if (!videos.has(video)) {
        button.remove();
        this.buttons.delete(video);
      }
    }
    for (const video of videos) this.position(video);
  }

  private position(video: HTMLVideoElement): void {
    const box = video.getBoundingClientRect();
    const isUsable =
      box.width >= MIN_SIDE_PX && box.height >= MIN_SIDE_PX && video.checkVisibility();
    let button = this.buttons.get(video);
    if (!isUsable) {
      if (button) button.style.display = "none";
      return;
    }
    if (!button) {
      button = this.createButton(video);
      this.buttons.set(video, button);
      this.layer.append(button);
    }
    const { style } = button;
    style.display = "flex";
    style.left = `${box.left}px`;
    style.top = `${box.top}px`;
    style.width = `${box.width}px`;
    style.height = `${box.height}px`;
    const text = this.labelFor(video);
    const label = button.firstElementChild;
    if (label && label.textContent !== text) label.textContent = text;
    if (button.getAttribute("aria-label") !== text) button.setAttribute("aria-label", text);
  }

  private labelFor(video: HTMLVideoElement): string {
    return [
      translate(this.messages, "pickerThis"),
      video.videoWidth > 0 ? `${video.videoWidth}×${video.videoHeight}` : null,
      formatDuration(video.duration),
    ]
      .filter(Boolean)
      .join(" · ");
  }

  private createButton(video: HTMLVideoElement): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.style.cssText = `all: unset; box-sizing: border-box; position: fixed; display: flex;
      align-items: flex-start; justify-content: flex-start; padding: 12px; cursor: pointer;
      pointer-events: auto; font: 700 14px ${FONT}; outline: 3px solid transparent;
      outline-offset: -3px; background: transparent;`;

    const label = document.createElement("span");
    label.style.cssText = `padding: 8px 12px; border-radius: 10px; background: ${BACKGROUND};
      color: ${TEXT}; pointer-events: none;`;
    button.append(label);

    const setHighlighted = (isHighlighted: boolean) => {
      button.style.outlineColor = isHighlighted ? ACCENT : "transparent";
      label.style.background = isHighlighted ? ACCENT : BACKGROUND;
      label.style.color = isHighlighted ? ON_ACCENT : TEXT;
    };
    button.addEventListener("pointerenter", () => setHighlighted(true));
    button.addEventListener("pointerleave", () => setHighlighted(button.matches(":focus")));
    button.addEventListener("focus", () => setHighlighted(true));
    button.addEventListener("blur", () => setHighlighted(false));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.events.onPick(video);
    });
    return button;
  }

  private createBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.setAttribute("role", "status");
    bar.style.cssText = `position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 14px; padding: 10px 10px 10px 18px;
      border-radius: 16px; background: ${BACKGROUND}; border: 1px solid ${BORDER}; color: ${TEXT};
      white-space: nowrap; pointer-events: auto; font-family: ${FONT};`;

    const hint = document.createElement("span");
    hint.textContent = translate(this.messages, "pickerHint");
    hint.style.cssText = "font-size: 15px; font-weight: 600;";

    const remember = document.createElement("span");
    remember.textContent = translate(this.messages, "pickerRemembered");
    remember.style.cssText = `font-size: 13px; color: ${MUTED};`;

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = translate(this.messages, "pickerCancel");
    cancel.style.cssText = `all: unset; box-sizing: border-box; height: 44px; padding: 0 16px;
      display: flex; align-items: center; border: 1px solid ${BUTTON_BORDER}; border-radius: 12px;
      color: ${TEXT}; font: 600 14px ${FONT}; cursor: pointer; outline: 2px solid transparent;
      outline-offset: 2px;`;
    cancel.addEventListener("focus", () => (cancel.style.outlineColor = ACCENT));
    cancel.addEventListener("blur", () => (cancel.style.outlineColor = "transparent"));
    cancel.addEventListener("click", () => this.events.onCancel());

    bar.append(hint, remember, cancel);
    return bar;
  }
}
