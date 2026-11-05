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

/** Accepts a room code or a whole invite link. Returns the code, or null if there isn't one. */
export function parseRoomInput(input: string): string | null {
  const direct = normalizeRoomCode(input);
  if (direct) return direct;

  const fragment = input.trim().split("#")[1];
  const room = fragment ? new URLSearchParams(fragment).get("room") : null;
  return room ? normalizeRoomCode(room) : null;
}
