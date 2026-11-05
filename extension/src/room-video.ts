// The address and title of a room's video, as they travel through the server. They're
// encrypted with a key made from the room code, so they aren't sitting in plain sight in
// storage or logs. The server sees room codes too, so this doesn't hide them from whoever
// operates the server.
export type RoomVideo = { url: string; title: string };

const MAX_ADDRESS_LENGTH = 2048;
const MAX_TITLE_CHARACTERS = 200;
const IV_BYTES = 12;
const KEY_CONTEXT = new TextEncoder().encode("sinkro room video v1");

async function keyFor(code: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(code),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: KEY_CONTEXT, info: KEY_CONTEXT },
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
