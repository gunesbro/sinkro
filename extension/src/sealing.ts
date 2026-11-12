// What travels through the server sealed: encrypted with a key made from the room code, so it
// isn't sitting in plain sight in storage or logs. The server sees room codes too, so this
// doesn't hide anything from whoever operates the server.
const IV_BYTES = 12;

/**
 * The room's key for one kind of sealed value. Each kind has a context of its own, so one
 * can't be passed off as another.
 */
export async function keyFor(code: string, context: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(code),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const bytes = new TextEncoder().encode(context);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bytes, info: bytes },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealText(key: CryptoKey, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(text),
  );
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(sealed)));
}

/** Null for anything that doesn't open with this key. */
export async function openText(key: CryptoKey, sealed: string): Promise<string | null> {
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
