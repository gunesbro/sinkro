// A miniplayer: a small video pinned over a page that's about something else, so the page's
// address doesn't say which film this is. Nothing here is specific to one site.
const MAX_SHARE_OF_WINDOW = 0.5;
/**
 * A feed's thumbnail is around a tenth of the window, and a page's own player around four
 * tenths even when it's modest. A muted film opened by clicking has the pointer resting on it.
 */
const MAX_PREVIEW_SHARE_OF_WINDOW = 0.25;

type Box = { width: number; height: number };

export function isSmallInWindow(video: Box, window: Box): boolean {
  const area = window.width * window.height;
  return area > 0 && (video.width * video.height) / area < MAX_SHARE_OF_WINDOW;
}

export function isPreviewSized(video: Box, window: Box): boolean {
  const area = window.width * window.height;
  return area > 0 && (video.width * video.height) / area < MAX_PREVIEW_SHARE_OF_WINDOW;
}

/**
 * Not a film anyone would bring a room to: muted and preview-sized, the way a page's previews
 * play, or not on the page at all, like a player a site keeps after leaving its page.
 */
export function isPreviewLike(
  video: { muted: boolean; volume: number; getBoundingClientRect(): Box },
  window: Box,
): boolean {
  const box = video.getBoundingClientRect();
  if (box.width * box.height === 0) return true;
  return (video.muted || video.volume === 0) && isPreviewSized(box, window);
}

export type PreviewSignals = {
  muted: boolean;
  isSmall: boolean;
  isPointerOver: boolean;
  wasClicked: boolean;
  /** Seconds in. A muted film the pointer passes over later on is well past the start. */
  position: number;
  /** Already taken for one, since it has to stay one after the pointer moves on and it stops. */
  wasPreview: boolean;
};

/** A preview starts as the pointer arrives, though a site can start one out of sight a few seconds early. Further in than this, it isn't one. */
const PREVIEW_START_SECONDS = 10;

/**
 * What a feed plays under the pointer. It isn't what anyone came to watch: it stops when the
 * pointer moves on, which mustn't pause the room, and its page isn't the film's. Clicking it
 * or turning on its sound says otherwise.
 */
export function isHoverPreview(video: PreviewSignals): boolean {
  if (!video.muted || !video.isSmall || video.wasClicked) return false;
  return video.wasPreview || (video.isPointerOver && video.position < PREVIEW_START_SECONDS);
}

function parentAcrossShadow(node: Element): Element | null {
  if (node.parentElement) return node.parentElement;
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

export function isFloatingPlayer(video: HTMLVideoElement | null): boolean {
  if (!video) return false;
  const size = { width: window.innerWidth, height: window.innerHeight };
  if (!isSmallInWindow(video.getBoundingClientRect(), size)) return false;

  for (let node: Element | null = video; node; node = parentAcrossShadow(node)) {
    if (getComputedStyle(node).position === "fixed") return true;
  }
  return false;
}
