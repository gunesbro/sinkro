import type { ReactionId } from "../../../server/src/protocol";
import { FLOATER_MS, REACTION_EMOJI } from "../reactions";
import { FONT, OVERLAY_BACKGROUND, TEXT } from "./theme";

/** How far a reaction rises before it's gone. */
const RISE_PX = 120;
/** Between the badge and the nearest reaction, so neither covers the other. */
const CLEAR_OF_BADGE_PX = 30;
/** Each starts a little to one side of the last, so several at once can all be seen. */
const SPREAD_PX = 28;
/** Kept this far inside the video's edges. */
const INSIDE_PX = 24;
/** If an animation never says it's finished, as in a tab that's been put to sleep. */
const REMOVE_ANYWAY_MS = FLOATER_MS + 500;

/** What a screen reader hears: whose reaction, when that's known, and which. */
export function floaterLabel(name: string | null, emoji: string): string {
  return name === null ? emoji : `${name}: ${emoji}`;
}

/**
 * The reactions rising beside the badge. They live in the badge's shadow root, take no
 * clicks and touch nothing of the page. Styled through the CSSOM and animated with the Web
 * Animations API, because a page's CSP can block style elements.
 */
export class ReactionsLayer {
  private readonly live = document.createElement("div");
  private readonly floaters = new Set<HTMLElement>();

  constructor(private readonly root: ShadowRoot) {
    this.live.setAttribute("role", "status");
    this.live.setAttribute("aria-live", "polite");
    this.live.style.cssText = `position: fixed; width: 1px; height: 1px; overflow: hidden;
      clip-path: inset(50%); white-space: nowrap; pointer-events: none;`;
    root.append(this.live);
  }

  /**
   * `badge` is what's showing of the badge now, open or not, and `video` the film's box. The
   * reaction rises in a lane beside the badge, on the side with more of the video.
   */
  show(id: ReactionId, name: string | null, badge: DOMRect, video: DOMRect): void {
    const emoji = REACTION_EMOJI[id];
    const floater = document.createElement("div");
    floater.setAttribute("aria-hidden", "true");
    floater.dataset.floater = id;
    floater.style.cssText = `position: fixed; display: flex; flex-direction: column;
      align-items: center; gap: 2px; pointer-events: none; user-select: none; opacity: 0;
      font-family: ${FONT}; will-change: transform, opacity;`;

    const character = document.createElement("span");
    character.textContent = emoji;
    character.style.cssText = `font-size: 28px; line-height: 1.15;
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));`;
    floater.append(character);
    if (name !== null) {
      const label = document.createElement("span");
      label.textContent = name;
      label.style.cssText = `padding: 1px 7px; border-radius: 999px; background: ${OVERLAY_BACKGROUND};
        color: ${TEXT}; font-size: 12px; font-weight: 600; line-height: 1.5; white-space: nowrap;`;
      floater.append(label);
    }

    const isBadgeOnRight = badge.left + badge.width / 2 > video.left + video.width / 2;
    const away = isBadgeOnRight ? -1 : 1;
    const beside = isBadgeOnRight ? badge.left : badge.right;
    const x = beside + away * (CLEAR_OF_BADGE_PX + Math.random() * SPREAD_PX);
    const left = Math.min(Math.max(x, video.left + INSIDE_PX), video.right - INSIDE_PX);
    const start = Math.min(video.bottom - 2 * INSIDE_PX, badge.top + RISE_PX - INSIDE_PX);
    const rise = Math.max(0, Math.min(RISE_PX, start - video.top - INSIDE_PX));
    floater.style.left = `${left}px`;
    floater.style.top = `${start}px`;

    this.root.append(floater);
    this.floaters.add(floater);
    this.live.textContent = floaterLabel(name, emoji);

    const isStill = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const at = (y: number, scale = 1) => `translate(-50%, ${isStill ? 0 : -y}px) scale(${scale})`;
    const animation = floater.animate(
      [
        { opacity: 0, transform: at(0, isStill ? 1 : 0.6) },
        { opacity: 1, transform: at(rise * 0.15), offset: 0.15 },
        { opacity: 1, transform: at(rise * 0.75), offset: 0.75 },
        { opacity: 0, transform: at(rise) },
      ],
      { duration: FLOATER_MS, easing: "ease-out" },
    );
    const remove = () => {
      floater.remove();
      this.floaters.delete(floater);
    };
    animation.addEventListener("finish", remove);
    animation.addEventListener("cancel", remove);
    setTimeout(remove, REMOVE_ANYWAY_MS);
  }

  clear(): void {
    for (const floater of this.floaters) floater.remove();
    this.floaters.clear();
    this.live.textContent = "";
  }
}
