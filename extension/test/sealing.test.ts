import { describe, expect, it } from "vitest";
import { openName } from "../src/names";
import { openPlayerHost, openRoomVideo } from "../src/room-video";
import { keyFor, openText, sealText } from "../src/sealing";

// People in a room run different versions, so what one seals another must open.
describe("what version 0.1.3 sealed", () => {
  const CODE = "K7M-2QX";

  it("still opens as a name", async () => {
    const sealed = "T9//RE+57zgKMZEpf8AAGhzwd9pacyfiq2b50XJb07umkwMshAxe7ovr5Q==";
    expect(await openName(CODE, sealed)).toEqual([10, 1]);
  });

  it("still opens as a room's video", async () => {
    const sealed =
      "bbBikFNetifIRRwzy2NheM/43K/yDH4A2kxtfYPce5Uw/8D20yjs+LMMYhQglTsi2J7qwiQ6G2rA4F+SjSPXpv7OB+CVxMoWfALczJvXBZrbZVmt+M4IVDc=";
    expect(await openRoomVideo(CODE, sealed)).toEqual({
      url: "https://videos.example/watch?v=1",
      title: "The Film",
    });
  });

  it("still opens as a player's site", async () => {
    const sealed = "Jlvib3Rb8OsdIYCLVxceHKm3rQAIPEvHS7w7jtXrE0cUzCkRNN/k6aUOMamn";
    expect(await openPlayerHost(CODE, sealed)).toBe("video.example.com");
  });
});

describe("sealing", () => {
  it("opens what it sealed, and nothing sealed for another kind of value", async () => {
    const sealed = await sealText(await keyFor("K7M-2QX", "one kind"), "hello");
    expect(await openText(await keyFor("K7M-2QX", "one kind"), sealed)).toBe("hello");
    expect(await openText(await keyFor("K7M-2QX", "another kind"), sealed)).toBeNull();
  });

  it("gives null for something that isn't sealed at all", async () => {
    expect(await openText(await keyFor("K7M-2QX", "one kind"), "not sealed")).toBeNull();
  });
});
