// A miniplayer: a small video pinned over a page that's about something else, so the page's
// address doesn't say which film this is. Nothing here is specific to one site.
const MAX_SHARE_OF_WINDOW = 0.5;

type Box = { width: number; height: number };

export function isSmallInWindow(video: Box, window: Box): boolean {
  const area = window.width * window.height;
  return area > 0 && (video.width * video.height) / area < MAX_SHARE_OF_WINDOW;
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
