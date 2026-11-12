import { describe, expect, it } from "vitest";
import { formatRate, formatTimecode } from "../src/format";
import {
  inviteLink,
  inviteTabToShow,
  isSamePage,
  parseInviteFragment,
  parseJoinInput,
} from "../src/invite";

describe("formatRate", () => {
  it.each([
    [1, "1x"],
    [1.5, "1.5x"],
    [0.75, "0.75x"],
    [1.3333333, "1.33x"],
  ])("shows %s as %s", (rate, shown) => {
    expect(formatRate(rate)).toBe(shown);
  });
});

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
    ["https://a.com/x?v=1&t=5", "https://www.a.com/x?v=1"],
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

describe("the invite tab to show once Sinkro is installed", () => {
  const invite = "https://sinkro.pages.dev/#room=K7M-2QX";

  it("is the one with an invite, not the plain landing page", () => {
    const tabs = [
      { id: 1, url: "https://sinkro.pages.dev/", lastAccessed: 30 },
      { id: 2, url: invite, lastAccessed: 10 },
    ];
    expect(inviteTabToShow(tabs)?.id).toBe(2);
  });

  it("is the one looked at last, when there are several", () => {
    const tabs = [
      { id: 1, url: invite, lastAccessed: 10 },
      { id: 2, url: "https://sinkro.pages.dev/#room=ABC-DEF", lastAccessed: 20 },
    ];
    expect(inviteTabToShow(tabs)?.id).toBe(2);
  });

  it("is none without an invite to join, or on another site's page", () => {
    expect(inviteTabToShow([])).toBeNull();
    expect(inviteTabToShow([{ id: 1, url: "https://sinkro.pages.dev/#room=nope" }])).toBeNull();
    expect(inviteTabToShow([{ id: 1, url: "https://example.com/#room=K7M-2QX" }])).toBeNull();
    expect(inviteTabToShow([{ id: 1, lastAccessed: 5 }])).toBeNull();
  });
});
