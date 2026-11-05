import { describe, expect, it } from "vitest";
import { isHoverPreview, isSmallInWindow } from "../src/content/detection/floating";

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
