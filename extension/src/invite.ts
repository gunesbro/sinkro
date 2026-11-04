import { normalizeRoomCode } from "../../server/src/room-code";

const INVITE_PAGE = "https://sinkro.pages.dev/";

/**
 * Everything sits in the fragment, which browsers never send to a server, so the page
 * address goes from one person to another without reaching the invite page's host.
 */
export function inviteLink(code: string, pageUrl: string | null): string {
  const parts = [`room=${encodeURIComponent(code)}`];
  if (pageUrl && /^https?:/.test(pageUrl)) parts.push(`url=${encodeURIComponent(pageUrl)}`);
  return `${INVITE_PAGE}#${parts.join("&")}`;
}

/** Accepts a room code or a whole invite link. Returns the code, or null if there isn't one. */
export function parseRoomInput(input: string): string | null {
  const direct = normalizeRoomCode(input);
  if (direct) return direct;

  const fragment = input.trim().split("#")[1];
  const room = fragment ? new URLSearchParams(fragment).get("room") : null;
  return room ? normalizeRoomCode(room) : null;
}
