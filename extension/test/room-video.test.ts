import { describe, expect, it } from "vitest";
import { openRoomVideo, sealRoomVideo } from "../src/room-video";

const VIDEO = "https://www.example.com/watch?v=1&t=2#frag";

describe("the sealed address of a room's video", () => {
  it("opens with the same room code", async () => {
    const sealed = await sealRoomVideo("K7M-2QX", VIDEO);
    expect(sealed).not.toBeNull();
    expect(await openRoomVideo("K7M-2QX", sealed ?? "")).toBe(VIDEO);
  });

  it("doesn't show the address", async () => {
    const sealed = (await sealRoomVideo("K7M-2QX", VIDEO)) ?? "";
    expect(sealed).not.toContain("example");
    expect(atob(sealed)).not.toContain("example");
  });

  it("doesn't open with another code", async () => {
    const sealed = (await sealRoomVideo("K7M-2QX", VIDEO)) ?? "";
    expect(await openRoomVideo("K7M-2QY", sealed)).toBeNull();
  });

  it("comes out different each time", async () => {
    expect(await sealRoomVideo("K7M-2QX", VIDEO)).not.toBe(await sealRoomVideo("K7M-2QX", VIDEO));
  });

  it("fits what the server accepts, at the longest address allowed", async () => {
    const long = `https://example.com/${"x".repeat(2048 - 20)}`;
    const sealed = (await sealRoomVideo("K7M-2QX", long)) ?? "";
    expect(sealed.length).toBeGreaterThan(0);
    expect(sealed.length).toBeLessThanOrEqual(3500);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///C:/secret",
    "chrome://settings",
    "not a url",
    `https://example.com/${"x".repeat(2048)}`,
  ])("won't seal %s", async (address) => {
    expect(await sealRoomVideo("K7M-2QX", address)).toBeNull();
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
      new TextEncoder().encode("javascript:alert(1)"),
    );
    const encoded = btoa(String.fromCharCode(...iv, ...new Uint8Array(sealed)));

    expect(await openRoomVideo("K7M-2QX", encoded)).toBeNull();
  });

  it.each(["", "not base64!", "AAAA", btoa("x".repeat(40))])("won't open %j", async (sealed) => {
    expect(await openRoomVideo("K7M-2QX", sealed)).toBeNull();
  });
});
