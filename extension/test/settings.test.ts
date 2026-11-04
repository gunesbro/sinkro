import { describe, expect, it } from "vitest";
import { normalizeServerUrl, roomSocketUrl } from "../src/settings";

describe("normalizeServerUrl", () => {
  it.each([
    ["https://sinkro.example.com", "https://sinkro.example.com"],
    ["https://sinkro.example.com/", "https://sinkro.example.com"],
    ["  https://sinkro.example.com/  ", "https://sinkro.example.com"],
    ["http://localhost:8787", "http://localhost:8787"],
    ["https://example.com/sinkro/", "https://example.com/sinkro"],
    ["https://example.com/sinkro?x=1#y", "https://example.com/sinkro"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  it.each(["", "sinkro.example.com", "ftp://example.com", "javascript:alert(1)", "file:///x"])(
    "rejects %j",
    (input) => {
      expect(normalizeServerUrl(input)).toBeNull();
    },
  );
});

describe("roomSocketUrl", () => {
  it.each([
    ["https://sinkro.example.com", "wss://sinkro.example.com/rooms/K7M-2QX/ws"],
    ["http://localhost:8787", "ws://localhost:8787/rooms/K7M-2QX/ws"],
    ["https://example.com/sinkro", "wss://example.com/sinkro/rooms/K7M-2QX/ws"],
  ])("builds from %s", (serverUrl, expected) => {
    expect(roomSocketUrl(serverUrl, "K7M-2QX")).toBe(expected);
  });
});
