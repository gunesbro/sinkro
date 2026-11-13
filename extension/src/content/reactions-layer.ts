import type { ReactionId } from "../../../server/src/protocol";
import { FLOATER_MS, REACTION_EMOJI } from "../reactions";
import { FONT, OVERLAY_BACKGROUND_QUIET, TEXT } from "./theme";

/** A reaction rises this share of the video's height, within these limits. */
const RISE_SHARE = 0.3;
const MIN_RISE_PX = 80;
const MAX_RISE_PX = 140;
/** From the video's edge to the middle of the lane reactions rise in: room for half a long name. */
const FROM_EDGE_PX = 64;
/** Above the bottom of the video, where players keep their controls. */
const ABOVE_BOTTOM_PX = 96;
/** Between the badge and the nearest reaction, when the badge is in the lane's way. */
const CLEAR_OF_BADGE_PX = 30;
/** Each starts a little to one side of the last, so several at once can all be seen. */
const SPREAD_PX = 16;
/** Kept this far inside the video's edges. */
const INSIDE_PX = 24;
/** Seen, but not pulling the eye off the film. */
const EMOJI_OPACITY = 0.85;
/** If an animation never says it's finished, as in a tab that's been put to sleep. */
const REMOVE_ANYWAY_MS = FLOATER_MS + 500;

/** What a screen reader hears: whose reaction, when that's known, and which. */
export function floaterLabel(name: string | null, emoji: string): string {
  return name === null ? emoji : `${name}: ${emoji}`;
}

/**
 * The reactions rising up the edge of the video. They live in the badge's shadow root, take no
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
   * reaction rises near the bottom of the video, along the edge the badge is on, which keeps it
   * off the middle of the picture and off subtitles. If the badge sits in that lane, the lane
   * moves in beside it.
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
    character.style.cssText = `font-size: 22px; line-height: 1.15; opacity: ${EMOJI_OPACITY};
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45));`;
    floater.append(character);
    if (name !== null) {
      const label = document.createElement("span");
      label.textContent = name;
      label.style.cssText = `padding: 0 6px; border-radius: 999px; background: ${OVERLAY_BACKGROUND_QUIET};
        color: ${TEXT}; font-size: 11px; font-weight: 600; line-height: 1.5; white-space: nowrap;`;
      floater.append(label);
    }

    const isBadgeOnRight = badge.left + badge.width / 2 > video.left + video.width / 2;
    const inward = isBadgeOnRight ? -1 : 1;
    const edge = isBadgeOnRight ? video.right : video.left;
    const start = Math.max(video.top + INSIDE_PX, video.bottom - ABOVE_BOTTOM_PX);
    const rise = Math.max(
      0,
      Math.min(
        Math.max(MIN_RISE_PX, Math.min(MAX_RISE_PX, video.height * RISE_SHARE)),
        start - video.top - INSIDE_PX,
      ),
    );
    // With the badge low on that edge, the lane would run through it.
    const isBadgeInTheWay =
      badge.bottom > start - rise - INSIDE_PX && badge.top < start + 2 * INSIDE_PX;
    const lane = isBadgeInTheWay
      ? (isBadgeOnRight ? badge.left : badge.right) + inward * CLEAR_OF_BADGE_PX
      : edge + inward * FROM_EDGE_PX;
    const x = lane + inward * Math.random() * SPREAD_PX;
    const left = Math.min(Math.max(x, video.left + INSIDE_PX), video.right - INSIDE_PX);
    floater.style.left = `${left}px`;
    floater.style.top = `${start}px`;

    this.root.append(floater);
    this.floaters.add(floater);
    this.live.textContent = floaterLabel(name, emoji);

    const isStill = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const at = (y: number) => `translate(-50%, ${isStill ? 0 : -y}px)`;
    const animation = floater.animate(
      [
        { opacity: 0, transform: at(0) },
        { opacity: 1, transform: at(rise * 0.2), offset: 0.2 },
        { opacity: 1, transform: at(rise * 0.7), offset: 0.7 },
        { opacity: 0, transform: at(rise) },
      ],
      { duration: FLOATER_MS, easing: "linear" },
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
