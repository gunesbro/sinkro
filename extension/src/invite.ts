import { normalizeRoomCode } from "../../server/src/room-code";

const INVITE_PAGE = "https://sinkro.pages.dev/";
export const INVITE_ORIGIN = new URL(INVITE_PAGE).origin;

/**
 * Everything sits in the fragment, which browsers never send to a server, so the page
 * address goes from one person to another without reaching the invite page's host.
 */
export function inviteLink(code: string, pageUrl: string | null): string {
  const parts = [`room=${encodeURIComponent(code)}`];
  if (pageUrl && /^https?:/.test(pageUrl)) parts.push(`url=${encodeURIComponent(pageUrl)}`);
  return `${INVITE_PAGE}#${parts.join("&")}`;
}

/** Reads the part of an invite link after the #. Anything that isn't valid comes back null. */
export function parseInviteFragment(fragment: string): { code: string; url: string | null } | null {
  const params = new URLSearchParams(fragment);
  const code = normalizeRoomCode(params.get("room") ?? "");
  if (!code) return null;

  try {
    const url = new URL(params.get("url") ?? "");
    // Never javascript: or the like, since the extension will send the tab there.
    return { code, url: /^https?:$/.test(url.protocol) ? url.href : null };
  } catch {
    return { code, url: null };
  }
}

/**
 * Of the tabs open on the invite page, the one to bring forward once Sinkro is installed: one
 * with an invite to join, and the one looked at last if there are several.
 */
export function inviteTabToShow<T extends { url?: string; lastAccessed?: number }>(
  tabs: T[],
): T | null {
  let shown: T | null = null;
  for (const tab of tabs) {
    let address: URL;
    try {
      address = new URL(tab.url ?? "");
    } catch {
      continue;
    }
    if (address.origin !== INVITE_ORIGIN || !parseInviteFragment(address.hash.slice(1))) continue;
    if (!shown || (tab.lastAccessed ?? 0) > (shown.lastAccessed ?? 0)) shown = tab;
  }
  return shown;
}

/** Accepts a room code or a whole invite link. Returns the code, or null if there isn't one. */
export function parseJoinInput(input: string): { code: string; url: string | null } | null {
  const code = normalizeRoomCode(input);
  if (code) return { code, url: null };

  const trimmed = input.trim();
  const hash = trimmed.indexOf("#");
  return hash === -1 ? null : parseInviteFragment(trimmed.slice(hash + 1));
}

/** Address parts that say where in a video or how someone got there, not which video it is. */
const NOT_THE_VIDEO = new Set([
  "t",
  "start",
  "time_continue",
  "si",
  "pp",
  "feature",
  "ab_channel",
  "fbclid",
  "gclid",
  "ref",
  "ref_",
  "jic",
  "trackId",
  "tctx",
]);

/** The same for two addresses of one video. Null for something that isn't an address. */
export function videoPageKey(address: string): string | null {
  try {
    const { host, pathname, searchParams } = new URL(address);
    const params = [...searchParams]
      .filter(([name]) => !NOT_THE_VIDEO.has(name) && !name.startsWith("utm_"))
      .map(([name, value]) => `${name}=${value}`)
      .sort();
    return `${host.replace(/^www\./, "")}${pathname.replace(/\/$/, "")}?${params.join("&")}`;
  } catch {
    return null;
  }
}

/** Whether two addresses are the same page, as far as which video is on it. */
export function isSamePage(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const key = videoPageKey(a);
  return key !== null && key === videoPageKey(b);
}
