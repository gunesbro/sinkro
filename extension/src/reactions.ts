import type { ReactionId } from "../../server/src/protocol";

export const REACTION_EMOJI: Record<ReactionId, string> = {
  laugh: "😂",
  heart: "❤️",
  wow: "😮",
  sad: "😢",
  clap: "👏",
  fire: "🔥",
};

/** Between one reaction and the next. The server passes on six in ten seconds from one person. */
export const COOLDOWN_MS = 2000;
/** How long a reaction is on screen. */
export const FLOATER_MS = 2000;
/** More than this at once and they'd cover the film. */
export const MAX_ON_SCREEN = 12;
/** So one person can't fill the screen alone. */
export const MAX_PER_PERSON = 2;

/** A reaction on screen: whose it is, and when it's gone. */
export type Floater = { from: string; until: number };

/**
 * The reactions on screen once this one has joined them, or null if it's one too many. A
 * hidden tab shows none, or they'd all rise at once when the viewer comes back.
 */
export function admit(
  onScreen: Floater[],
  from: string,
  now: number,
  hidden: boolean,
): Floater[] | null {
  if (hidden) return null;
  const left = onScreen.filter((floater) => floater.until > now);
  if (left.length >= MAX_ON_SCREEN) return null;
  if (left.filter((floater) => floater.from === from).length >= MAX_PER_PERSON) return null;
  return [...left, { from, until: now + FLOATER_MS }];
}

export function canSend(lastSentAt: number | null, now: number): boolean {
  return lastSentAt === null || now - lastSentAt >= COOLDOWN_MS;
}
