// A miniplayer: a small video pinned over a page that's about something else, so the page's
// address doesn't say which film this is. Nothing here is specific to one site.
const MAX_SHARE_OF_WINDOW = 0.5;

type Box = { width: number; height: number };

export function isSmallInWindow(video: Box, window: Box): boolean {
  const area = window.width * window.height;
  return area > 0 && (video.width * video.height) / area < MAX_SHARE_OF_WINDOW;
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

/** A preview starts as the pointer arrives, so one further in than this isn't one. */
const PREVIEW_START_SECONDS = 3;

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
