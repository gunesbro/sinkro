// Codes look like K7M-2QX. The alphabet leaves out I, L, O, U, 0 and 1: they are
// easy to misread, and I would turn into a dotted İ when uppercased in Turkish.
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const LENGTH = 6;
const CANONICAL = new RegExp(`^[${ALPHABET}]{3}-[${ALPHABET}]{3}$`);

export function generateRoomCode(): string {
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % ALPHABET.length);
  const characters: string[] = [];
  while (characters.length < LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(LENGTH * 2))) {
      if (byte < limit && characters.length < LENGTH) {
        characters.push(ALPHABET.charAt(byte % ALPHABET.length));
      }
    }
  }
  return `${characters.slice(0, 3).join("")}-${characters.slice(3).join("")}`;
}

/** Accepts `k7m2qx` or `K7M-2QX`. Returns the canonical code, or null if it can't be one. */
export function normalizeRoomCode(input: string): string | null {
  const compact = input.trim().toUpperCase().replace("-", "");
  const code = `${compact.slice(0, 3)}-${compact.slice(3)}`;
  return CANONICAL.test(code) ? code : null;
}
