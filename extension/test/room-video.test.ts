import { describe, expect, it } from "vitest";
import { parseClientMessage } from "../../server/src/protocol";
import { openPlayerHost, openRoomVideo, sealPlayerHost, sealRoomVideo } from "../src/room-video";

const VIDEO = { url: "https://www.example.com/watch?v=1&t=2#frag", title: "Uzun Gece: Çığlık" };
const withAddress = (url: string) => ({ url, title: "" });

describe("the sealed name of a player's site", () => {
  it("opens with the same room code", async () => {
    const sealed = (await sealPlayerHost("K7M-2QX", "video.Example.com")) ?? "";
    expect(await openPlayerHost("K7M-2QX", sealed)).toBe("video.example.com");
  });

  it("doesn't show the name", async () => {
    const sealed = (await sealPlayerHost("K7M-2QX", "video.example.com")) ?? "";
    expect(atob(sealed)).not.toContain("example");
  });

  it("doesn't open with another code", async () => {
    const sealed = (await sealPlayerHost("K7M-2QX", "video.example.com")) ?? "";
    expect(await openPlayerHost("K7M-2QY", sealed)).toBeNull();
  });

  it("can't be passed off as a room's video, or the other way round", async () => {
    const host = (await sealPlayerHost("K7M-2QX", "video.example.com")) ?? "";
    const video = (await sealRoomVideo("K7M-2QX", VIDEO)) ?? "";
    expect(await openRoomVideo("K7M-2QX", host)).toBeNull();
    expect(await openPlayerHost("K7M-2QX", video)).toBeNull();
  });

  it.each(["", "a b", "x".repeat(254), "evil.com/path", "<b>"])("won't seal %j", async (host) => {
    expect(await sealPlayerHost("K7M-2QX", host)).toBeNull();
  });

  it("fits what the server accepts, at the longest name", async () => {
    const sealed = (await sealPlayerHost("K7M-2QX", "a".repeat(253))) ?? "";
    expect(sealed.length).toBeGreaterThan(0);
    expect(sealed.length).toBeLessThanOrEqual(400);
  });
});

describe("the sealed address of a room's video", () => {
  it("opens with the same room code", async () => {
    const sealed = await sealRoomVideo("K7M-2QX", VIDEO);
    expect(sealed).not.toBeNull();
    expect(await openRoomVideo("K7M-2QX", sealed ?? "")).toEqual(VIDEO);
  });

  it("doesn't show the address or the title", async () => {
    const sealed = (await sealRoomVideo("K7M-2QX", VIDEO)) ?? "";
    expect(sealed).not.toContain("example");
    expect(atob(sealed)).not.toContain("example");
    expect(atob(sealed)).not.toContain("Uzun");
  });

  it("keeps a page's title to one reasonable line", async () => {
    const title = `  Film\n\n\tName\u0000 ${"x".repeat(500)}`;
    const sealed = (await sealRoomVideo("K7M-2QX", { url: VIDEO.url, title })) ?? "";
    const opened = await openRoomVideo("K7M-2QX", sealed);
    expect(opened?.title.startsWith("Film Name x")).toBe(true);
    expect(opened?.title).toHaveLength(200);
  });

  it("doesn't cut a title in the middle of a character", async () => {
    const sealed = await sealRoomVideo("K7M-2QX", { url: VIDEO.url, title: "😀".repeat(300) });
    const opened = await openRoomVideo("K7M-2QX", sealed ?? "");
    expect(opened?.title).toBe("😀".repeat(200));
  });

  it("doesn't open with another code", async () => {
    const sealed = (await sealRoomVideo("K7M-2QX", VIDEO)) ?? "";
    expect(await openRoomVideo("K7M-2QY", sealed)).toBeNull();
  });

  it("comes out different each time", async () => {
    expect(await sealRoomVideo("K7M-2QX", VIDEO)).not.toBe(await sealRoomVideo("K7M-2QX", VIDEO));
  });

  it.each([
    ["wide characters", "😀".repeat(200)],
    ["characters that need escaping", '"\\'.repeat(100)],
    ["broken characters", "\ud83d".repeat(200)],
  ])("fits what the server accepts, at the longest address, with %s", async (_, title) => {
    const url = `https://example.com/${"x".repeat(2048 - 20)}`;
    const sealed = (await sealRoomVideo("K7M-2QX", { url, title })) ?? "";
    expect(sealed.length).toBeGreaterThan(0);
    expect(sealed.length).toBeLessThanOrEqual(3900);
    const message = JSON.stringify({ type: "video/set", sealed });
    expect(parseClientMessage(message)).not.toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///C:/secret",
    "chrome://settings",
    "not a url",
    `https://example.com/${"x".repeat(2048)}`,
  ])("won't seal %s", async (address) => {
    expect(await sealRoomVideo("K7M-2QX", withAddress(address))).toBeNull();
  });

  it("won't open an address a tab shouldn't go to, even one sealed properly", async () => {
    const context = new TextEncoder().encode("sinkro room video v1");
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("K7M-2QX"),
      "HKDF",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: context, info: context },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const iv = new Uint8Array(12);
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(withAddress("javascript:alert(1)"))),
    );
    const encoded = btoa(String.fromCharCode(...iv, ...new Uint8Array(sealed)));

    expect(await openRoomVideo("K7M-2QX", encoded)).toBeNull();
  });

  it.each(["", "not base64!", "AAAA", btoa("x".repeat(40))])("won't open %j", async (sealed) => {
    expect(await openRoomVideo("K7M-2QX", sealed)).toBeNull();
  });
});
