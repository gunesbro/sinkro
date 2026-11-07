// The name someone goes by in a room: an adjective and an animal picked at random, like
// "Calm Owl". Nobody types one, so it never says who someone is. It's kept as the two picks,
// not the words, so each person reads everyone's names in their own language.
import type { Messages } from "./i18n";

/** Which adjective and which animal, by their place in the lists. */
export type NamePick = readonly [adjective: number, animal: number];

const STORAGE_KEY = "roomName";
const NAME_CONTEXT = new TextEncoder().encode("sinkro room name v1");
const IV_BYTES = 12;
/** Both lists are this long in every language, which the locale tests hold them to. */
export const ADJECTIVES = 16;
export const ANIMALS = 16;

function isPick(value: unknown): value is NamePick {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isInteger(value[0]) &&
    Number.isInteger(value[1]) &&
    value[0] >= 0 &&
    value[0] < ADJECTIVES &&
    value[1] >= 0 &&
    value[1] < ANIMALS
  );
}

export function randomPick(random: () => number = Math.random, not?: NamePick): NamePick {
  for (;;) {
    const pick: NamePick = [Math.floor(random() * ADJECTIVES), Math.floor(random() * ANIMALS)];
    if (!not || pick[0] !== not[0] || pick[1] !== not[1]) return pick;
  }
}

/** This browser's name, picked the first time it's needed and kept after that. */
export async function getOwnName(): Promise<NamePick> {
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (isPick(stored)) return stored;
  const pick = randomPick();
  await chrome.storage.local.set({ [STORAGE_KEY]: pick });
  return pick;
}

/** Another one at random, for someone who doesn't like theirs. */
export async function pickAnotherName(): Promise<NamePick> {
  const pick = randomPick(Math.random, await getOwnName());
  await chrome.storage.local.set({ [STORAGE_KEY]: pick });
  return pick;
}

export function isOwnNameChange(changes: Record<string, unknown>): boolean {
  return STORAGE_KEY in changes;
}

function words(messages: Messages, key: string): string[] {
  return (messages[key]?.message ?? "").split("|").map((word) => word.trim());
}

/** The name in the reader's language, or null if their lists don't have it. */
export function nameText(pick: NamePick, messages: Messages): string | null {
  const adjective = words(messages, "nameAdjectives")[pick[0]];
  const animal = words(messages, "nameAnimals")[pick[1]];
  return adjective && animal ? `${adjective} ${animal}` : null;
}

/**
 * Everyone's name as it should be shown, in the room's order. Two people can draw the same
 * name, so the second gets a number.
 */
export function namesInRoom(texts: (string | null)[]): (string | null)[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    if (text === null) return null;
    const count = (seen.get(text) ?? 0) + 1;
    seen.set(text, count);
    return count === 1 ? text : `${text} ${count}`;
  });
}

async function keyFor(code: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(code),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: NAME_CONTEXT, info: NAME_CONTEXT },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Sealed with a key from the room code, so the server can't read it. */
export async function sealName(code: string, pick: NamePick): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await keyFor(code),
    new TextEncoder().encode(JSON.stringify({ pick })),
  );
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(sealed)));
}

/** Null for anything that doesn't open with this code or isn't a name. */
export async function openName(code: string, sealed: string): Promise<NamePick | null> {
  try {
    const bytes = Uint8Array.from(atob(sealed), (character) => character.charCodeAt(0));
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) },
      await keyFor(code),
      bytes.slice(IV_BYTES),
    );
    const { pick } = JSON.parse(new TextDecoder().decode(opened)) as { pick?: unknown };
    return isPick(pick) ? pick : null;
  } catch {
    return null;
  }
}
