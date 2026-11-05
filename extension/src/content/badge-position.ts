/**
 * Where the viewer put the badge, as a share of the room to move in over the video, so it
 * stays in the same spot when the video changes size. 0,0 is the top left and 1,1 the
 * bottom right.
 */
export type BadgePosition = { x: number; y: number };
export type Box = { left: number; top: number; width: number; height: number };
export type Size = { width: number; height: number };

const INSET_PX = 12;
const KEY_STEP = 0.02;
/** With less of its video on screen than this, a badge would seem to belong to something else. */
const MIN_VISIBLE_SHARE = 0.3;

const clamp = (value: number) => Math.min(1, Math.max(0, value));

export type Placement = {
  /** Distance from the viewport's right edge when aligned right, otherwise from its left. */
  horizontal: { side: "left" | "right"; px: number };
  /** Distance from the viewport's bottom edge when the card opens upward, otherwise its top. */
  vertical: { side: "top" | "bottom"; px: number };
};

/** Keeps the card on the side with room for it, and everything inside the viewport. */
export function placeBadge(
  video: Box,
  pill: Size,
  viewport: Size,
  position: BadgePosition | null,
): Placement {
  const left = position
    ? video.left + position.x * (video.width - pill.width)
    : video.left + video.width - pill.width - INSET_PX;
  const top = position
    ? video.top + position.y * (video.height - pill.height)
    : video.top + INSET_PX;

  const alignRight = !position || position.x > 0.5;
  const opensUp = position !== null && position.y > 0.5;

  return {
    horizontal: alignRight
      ? { side: "right", px: Math.max(INSET_PX, viewport.width - left - pill.width) }
      : { side: "left", px: Math.max(INSET_PX, left) },
    vertical: opensUp
      ? { side: "bottom", px: Math.max(INSET_PX, viewport.height - top - pill.height) }
      : { side: "top", px: Math.max(INSET_PX, top) },
  };
}

/** Whether enough of the video is on screen for the badge to sit on it. */
export function isVideoOnScreen(video: Box, viewport: Size): boolean {
  const width = Math.min(video.left + video.width, viewport.width) - Math.max(video.left, 0);
  const height = Math.min(video.top + video.height, viewport.height) - Math.max(video.top, 0);
  if (width <= 0 || height <= 0) return false;
  return (width * height) / (video.width * video.height) >= MIN_VISIBLE_SHARE;
}

/** The position that puts the pill's top left corner at this point, as near as it can. */
export function positionAt(video: Box, pill: Size, left: number, top: number): BadgePosition {
  const roomX = video.width - pill.width;
  const roomY = video.height - pill.height;
  return {
    x: roomX > 0 ? clamp((left - video.left) / roomX) : 0,
    y: roomY > 0 ? clamp((top - video.top) / roomY) : 0,
  };
}

const ARROWS: Record<string, BadgePosition> = {
  ArrowLeft: { x: -KEY_STEP, y: 0 },
  ArrowRight: { x: KEY_STEP, y: 0 },
  ArrowUp: { x: 0, y: -KEY_STEP },
  ArrowDown: { x: 0, y: KEY_STEP },
};

/** The new position after an arrow key, or null if it isn't one. */
export function nudge(current: BadgePosition, key: string): BadgePosition | null {
  const step = ARROWS[key];
  return step ? { x: clamp(current.x + step.x), y: clamp(current.y + step.y) } : null;
}

// Kept per site, on this device only. It never reaches the server.
const keyFor = (hostname: string) => `badge:${hostname}`;

function isPosition(value: unknown): value is BadgePosition {
  const candidate = value as BadgePosition | null;
  return (
    typeof candidate?.x === "number" &&
    typeof candidate.y === "number" &&
    candidate.x >= 0 &&
    candidate.x <= 1 &&
    candidate.y >= 0 &&
    candidate.y <= 1
  );
}

export async function loadBadgePosition(hostname: string): Promise<BadgePosition | null> {
  const key = keyFor(hostname);
  const stored = await chrome.storage.local.get(key);
  return isPosition(stored[key]) ? stored[key] : null;
}

export async function saveBadgePosition(
  hostname: string,
  position: BadgePosition | null,
): Promise<void> {
  const key = keyFor(hostname);
  if (position) await chrome.storage.local.set({ [key]: position });
  else await chrome.storage.local.remove(key);
}
