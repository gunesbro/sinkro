// The address and title of a room's video, as they travel through the server. They're
// encrypted with a key made from the room code, so they aren't sitting in plain sight in
// storage or logs. The server sees room codes too, so this doesn't hide them from whoever
// operates the server.
export type RoomVideo = { url: string; title: string };

const MAX_ADDRESS_LENGTH = 2048;
const MAX_TITLE_CHARACTERS = 200;
const IV_BYTES = 12;
const KEY_CONTEXT = new TextEncoder().encode("sinkro room video v1");
/** A key of its own, so one kind of sealed value can't be passed off as the other. */
const HOST_CONTEXT = new TextEncoder().encode("sinkro player host v1");
const HOST_PATTERN = /^[a-z0-9.-]{1,253}$/i;

async function keyFor(code: string, context = KEY_CONTEXT): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(code),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: context, info: context },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function isOpenableAddress(address: string): boolean {
  try {
    return /^https?:$/.test(new URL(address).protocol);
  } catch {
    return false;
  }
}

/** Whatever a page calls itself, kept to one line of a size that fits what the server accepts. */
function tidyTitle(title: string): string {
  const oneLine = title.replace(/[\p{Cc}\p{Cs}\s]+/gu, " ").trim();
  return Array.from(oneLine).slice(0, MAX_TITLE_CHARACTERS).join("").trim();
}

/** Null for an address that shouldn't be shared: too long, or not a web page. */
export async function sealRoomVideo(
  code: string,
  { url, title }: RoomVideo,
): Promise<string | null> {
  if (url.length > MAX_ADDRESS_LENGTH || !isOpenableAddress(url)) return null;

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await keyFor(code),
    new TextEncoder().encode(JSON.stringify({ url, title: tidyTitle(title) })),
  );
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(sealed)));
}

/** Null for anything that doesn't open with this code or isn't a web page address. */
export async function openRoomVideo(code: string, sealed: string): Promise<RoomVideo | null> {
  try {
    const bytes = Uint8Array.from(atob(sealed), (character) => character.charCodeAt(0));
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) },
      await keyFor(code),
      bytes.slice(IV_BYTES),
    );
    const { url, title } = JSON.parse(new TextDecoder().decode(opened)) as Partial<RoomVideo>;
    if (typeof url !== "string" || !isOpenableAddress(url)) return null;
    return { url, title: typeof title === "string" ? tidyTitle(title) : "" };
  } catch {
    return null;
  }
}

async function sealText(key: CryptoKey, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(text),
  );
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(sealed)));
}

async function openText(key: CryptoKey, sealed: string): Promise<string | null> {
  try {
    const bytes = Uint8Array.from(atob(sealed), (character) => character.charCodeAt(0));
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) },
      key,
      bytes.slice(IV_BYTES),
    );
    return new TextDecoder().decode(opened);
  } catch {
    return null;
  }
}

/** The site a player comes from, like video.example.com. Null for anything else. */
export async function sealPlayerHost(code: string, host: string): Promise<string | null> {
  if (!HOST_PATTERN.test(host)) return null;
  return sealText(await keyFor(code, HOST_CONTEXT), host.toLowerCase());
}

export async function openPlayerHost(code: string, sealed: string): Promise<string | null> {
  const host = await openText(await keyFor(code, HOST_CONTEXT), sealed);
  return host && HOST_PATTERN.test(host) ? host : null;
}
