// The address and title of a room's video, as they travel through the server. They're
// encrypted with a key made from the room code, so they aren't sitting in plain sight in
// storage or logs. The server sees room codes too, so this doesn't hide them from whoever
// operates the server.
import { keyFor, openText, sealText } from "./sealing";

export type RoomVideo = { url: string; title: string };

const MAX_ADDRESS_LENGTH = 2048;
const MAX_TITLE_CHARACTERS = 200;
const VIDEO_CONTEXT = "sinkro room video v1";
/** A key of its own, so one kind of sealed value can't be passed off as the other. */
const HOST_CONTEXT = "sinkro player host v1";
const HOST_PATTERN = /^[a-z0-9.-]{1,253}$/i;

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

  return sealText(
    await keyFor(code, VIDEO_CONTEXT),
    JSON.stringify({ url, title: tidyTitle(title) }),
  );
}

/** Null for anything that doesn't open with this code or isn't a web page address. */
export async function openRoomVideo(code: string, sealed: string): Promise<RoomVideo | null> {
  const opened = await openText(await keyFor(code, VIDEO_CONTEXT), sealed);
  if (opened === null) return null;
  try {
    const { url, title } = JSON.parse(opened) as Partial<RoomVideo>;
    if (typeof url !== "string" || !isOpenableAddress(url)) return null;
    return { url, title: typeof title === "string" ? tidyTitle(title) : "" };
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
