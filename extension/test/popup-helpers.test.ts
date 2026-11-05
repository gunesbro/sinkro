import { describe, expect, it } from "vitest";
import { formatTimecode } from "../src/format";
import { inviteLink, isSamePage, parseInviteFragment, parseJoinInput } from "../src/invite";

describe("formatTimecode", () => {
  it.each([
    [0, "0:00"],
    [9.9, "0:09"],
    [83, "1:23"],
    [3600, "1:00:00"],
    [3723, "1:02:03"],
    [36_000, "10:00:00"],
  ])("formats %d", (seconds, expected) => {
    expect(formatTimecode(seconds)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("has nothing to say about %d", (seconds) => {
    expect(formatTimecode(seconds)).toBeNull();
  });
});

describe("inviteLink", () => {
  it("keeps everything in the fragment, which never reaches a server", () => {
    const link = new URL(inviteLink("K7M-2QX", "https://example.com/watch?v=1&t=2"));
    expect(link.search).toBe("");
    expect(link.pathname).toBe("/");

    const params = new URLSearchParams(link.hash.slice(1));
    expect(params.get("room")).toBe("K7M-2QX");
    expect(params.get("url")).toBe("https://example.com/watch?v=1&t=2");
  });

  it.each([null, "file:///C:/film.mp4", "chrome://settings", "about:blank"])(
    "leaves out a page address others couldn't open: %s",
    (pageUrl) => {
      expect(inviteLink("K7M-2QX", pageUrl)).toBe("https://sinkro.pages.dev/#room=K7M-2QX");
    },
  );
});

describe("parseInviteFragment", () => {
  const fragmentOf = (link: string) => link.split("#").slice(1).join("#");

  it("reads what inviteLink writes", () => {
    const url = "https://example.com/watch?v=1&t=2#frag";
    expect(parseInviteFragment(fragmentOf(inviteLink("K7M-2QX", url)))).toEqual({
      code: "K7M-2QX",
      url,
    });
  });

  it("takes a room with no address", () => {
    expect(parseInviteFragment("room=K7M-2QX")).toEqual({ code: "K7M-2QX", url: null });
  });

  it.each(["", "room=nope", "url=https%3A%2F%2Fexample.com"])(
    "finds no invite in %j",
    (fragment) => {
      expect(parseInviteFragment(fragment)).toBeNull();
    },
  );

  it.each([
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///C:/secret",
    "chrome://settings",
    "not a url",
  ])("won't send a tab to %s", (url) => {
    const fragment = `room=K7M-2QX&url=${encodeURIComponent(url)}`;
    expect(parseInviteFragment(fragment)).toEqual({ code: "K7M-2QX", url: null });
  });
});

describe("parseJoinInput", () => {
  it.each([
    ["K7M-2QX", "K7M-2QX"],
    ["k7m2qx", "K7M-2QX"],
    ["  k7m-2qx  ", "K7M-2QX"],
    ["https://sinkro.pages.dev/#room=K7M-2QX", "K7M-2QX"],
    ["https://sinkro.pages.dev/#room=k7m2qx&url=https%3A%2F%2Fexample.com", "K7M-2QX"],
    [inviteLink("K7M-2QX", "https://example.com/a#b"), "K7M-2QX"],
  ])("finds the code in %s", (input, expected) => {
    expect(parseJoinInput(input)?.code).toBe(expected);
  });

  it.each(["", "hello", "K7M", "https://sinkro.pages.dev/", "https://example.com/#room=nope"])(
    "finds no code in %j",
    (input) => {
      expect(parseJoinInput(input)).toBeNull();
    },
  );
});

describe("parseJoinInput and the video in a link", () => {
  it("has no video for a bare code", () => {
    expect(parseJoinInput("K7M-2QX")).toEqual({ code: "K7M-2QX", url: null });
  });

  it("finds the video in an invite link", () => {
    const url = "https://example.com/watch?v=1#t=5";
    expect(parseJoinInput(inviteLink("K7M-2QX", url))).toEqual({ code: "K7M-2QX", url });
  });

  it("won't take an address a tab shouldn't go to", () => {
    const link = `https://sinkro.pages.dev/#room=K7M-2QX&url=${encodeURIComponent("javascript:alert(1)")}`;
    expect(parseJoinInput(link)).toEqual({ code: "K7M-2QX", url: null });
  });
});

describe("isSamePage", () => {
  it.each([
    ["https://a.com/x?v=1", "https://a.com/x?v=1"],
    ["https://a.com/x?v=1#t=5", "https://a.com/x?v=1"],
  ])("treats %s and %s as the same page", (a, b) => {
    expect(isSamePage(a, b)).toBe(true);
  });

  it.each([
    [null, "https://a.com/"],
    ["https://a.com/x?v=1", "https://a.com/x?v=2"],
    ["https://a.com/x", "https://b.com/x"],
    ["not a url", "https://a.com/"],
  ])("treats %s and %s as different pages", (a, b) => {
    expect(isSamePage(a, b)).toBe(false);
  });
});
