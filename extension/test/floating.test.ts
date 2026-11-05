import { describe, expect, it } from "vitest";
import { isSmallInWindow } from "../src/content/detection/floating";

const window = { width: 1600, height: 900 };

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
