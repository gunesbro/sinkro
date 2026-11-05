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
export function parseJoinInput(input: string): { code: string; url: string | null } | null {
  const code = normalizeRoomCode(input);
  if (code) return { code, url: null };

  const trimmed = input.trim();
  const hash = trimmed.indexOf("#");
  return hash === -1 ? null : parseInviteFragment(trimmed.slice(hash + 1));
}

/** Whether two addresses are the same page, ignoring the fragment. */
export function isSamePage(a: string | null, b: string): boolean {
  if (!a) return false;
  try {
    const [first, second] = [new URL(a), new URL(b)];
    first.hash = "";
    second.hash = "";
    return first.href === second.href;
  } catch {
    return false;
  }
}
