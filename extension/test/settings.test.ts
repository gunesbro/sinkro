import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SERVER_URL,
  getCustomServerUrl,
  getServerUrl,
  normalizeServerUrl,
  roomSocketUrl,
  setServerUrl,
} from "../src/settings";

const stored = new Map<string, unknown>();
beforeEach(() => {
  stored.clear();
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string) => (stored.has(key) ? { [key]: stored.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) stored.set(key, value);
        },
        remove: async (key: string) => {
          stored.delete(key);
        },
      },
    },
  });
});

describe("the server address setting", () => {
  it("uses Sinkro's server, without calling it custom, until one is chosen", async () => {
    expect(await getServerUrl()).toBe(DEFAULT_SERVER_URL);
    expect(await getCustomServerUrl()).toBeNull();
  });

  it("keeps the viewer's own server", async () => {
    expect(await setServerUrl("https://sinkro.example.com/")).toBe(true);
    expect(await getCustomServerUrl()).toBe("https://sinkro.example.com");
    expect(await getServerUrl()).toBe("https://sinkro.example.com");
  });

  it("goes back to Sinkro's server when the field is emptied", async () => {
    await setServerUrl("https://sinkro.example.com");
    expect(await setServerUrl("   ")).toBe(true);
    expect(await getCustomServerUrl()).toBeNull();
    expect(await getServerUrl()).toBe(DEFAULT_SERVER_URL);
  });

  it("doesn't count Sinkro's own address as a custom one", async () => {
    expect(await setServerUrl(`${DEFAULT_SERVER_URL}/`)).toBe(true);
    expect(await getCustomServerUrl()).toBeNull();
  });

  it("refuses a bad address and keeps what was there", async () => {
    await setServerUrl("https://sinkro.example.com");
    expect(await setServerUrl("not a url")).toBe(false);
    expect(await getCustomServerUrl()).toBe("https://sinkro.example.com");
  });
});

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
