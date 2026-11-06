import { describe, expect, it } from "vitest";
import {
  isHoverPreview,
  isPreviewLike,
  isPreviewSized,
  isSmallInWindow,
} from "../src/content/detection/floating";

const window = { width: 1600, height: 900 };

describe("isHoverPreview", () => {
  const preview = {
    muted: true,
    isSmall: true,
    isPointerOver: true,
    wasClicked: false,
    position: 0.5,
    wasPreview: false,
  };

  it("knows a muted little video playing under the pointer", () => {
    expect(isHoverPreview(preview)).toBe(true);
  });

  it.each([
    ["has its sound on", { muted: false }],
    ["fills the page", { isSmall: false }],
    ["isn't under the pointer, like a muted film autoplaying", { isPointerOver: false }],
    ["the pointer found well into playing", { position: 40 }],
    ["has been clicked", { wasClicked: true }],
  ])("doesn't count a video that %s", (_, change) => {
    expect(isHoverPreview({ ...preview, ...change })).toBe(false);
  });
});

describe("isHoverPreview once it's been one", () => {
  const was = {
    muted: true,
    isSmall: true,
    isPointerOver: false,
    wasClicked: false,
    position: 30,
    wasPreview: true,
  };

  it("stays one after the pointer moves on, when the stop that follows mustn't reach the room", () => {
    expect(isHoverPreview(was)).toBe(true);
  });

  it.each([
    ["clicked", { wasClicked: true }],
    ["given its sound", { muted: false }],
    ["made big", { isSmall: false }],
  ])("stops being one when %s", (_, change) => {
    expect(isHoverPreview({ ...was, ...change })).toBe(false);
  });
});

describe("isPreviewSized", () => {
  it.each([
    ["a feed's thumbnail", { width: 400, height: 225 }, { width: 1280, height: 800 }, true],
    [
      "a thumbnail in a narrow window",
      { width: 400, height: 220 },
      { width: 950, height: 800 },
      true,
    ],
    [
      "YouTube's player on its own page",
      { width: 873, height: 491 },
      { width: 1280, height: 800 },
      false,
    ],
    ["a modest player on a page", { width: 800, height: 450 }, { width: 1600, height: 900 }, false],
  ])("judges %s", (_, video, size, expected) => {
    expect(isPreviewSized(video, size)).toBe(expected);
  });

  it("has no answer in a window with no size", () => {
    expect(isPreviewSized({ width: 10, height: 10 }, { width: 0, height: 0 })).toBe(false);
  });
});

describe("isSmallInWindow", () => {
  it.each([
    ["a miniplayer", { width: 400, height: 225 }, true],
    ["a modest player on a page", { width: 800, height: 450 }, true],
    ["a page's main player", { width: 1200, height: 675 }, false],
    ["a video filling the window", { width: 1600, height: 900 }, false],
  ])("judges %s", (_, video, expected) => {
    expect(isSmallInWindow(video, window)).toBe(expected);
  });

  it("has no answer in a window with no size", () => {
    expect(isSmallInWindow({ width: 100, height: 100 }, { width: 0, height: 0 })).toBe(false);
  });
});

describe("isPreviewLike", () => {
  const window = { width: 1000, height: 800 };
  const video = (box: { width: number; height: number }, muted = true, volume = 1) => ({
    muted,
    volume,
    getBoundingClientRect: () => ({ left: 0, top: 0, ...box }),
  });

  it.each([
    ["a muted preview on a feed", video({ width: 400, height: 225 }), true],
    ["one at volume zero", video({ width: 400, height: 225 }, false, 0), true],
    ["a player the site kept out of sight", video({ width: 0, height: 0 }, false), true],
    ["a film playing out loud", video({ width: 400, height: 225 }, false), false],
    ["a big muted film", video({ width: 900, height: 506 }), false],
  ])("%s: %s", (_, candidate, expected) => {
    expect(isPreviewLike(candidate, window)).toBe(expected);
  });
});
